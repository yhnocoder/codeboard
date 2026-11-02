// The real host behind harness pages: packages/host's startHost (BoardHub and its message handlers, Storage on a temp dir, version
// checks, the name index) on the Node Workspace over a repository, with each board view the host opens being a page of the
// harness. For scenarios about what the host does with boards: storage, sub-boards and their crumbs, shared cards, call resolution.
// The fixture host in harness.ts stays for the scenarios about the board itself on canned data.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Emitter,
  loadBoard,
  type AskType,
  type Board,
  type BoardToHost,
  type CodeCard,
  type HostToBoard,
  type ReplyOf,
} from "@codeboard/core";
import { startHost, type BoardView, type Host as RealHost, type HostEnv } from "@codeboard/host";
import { nodeWorkspace, symbolCard, type TestWorkspace } from "@codeboard/host/testing";
import { OUT, REPO, type Host, type OpenOptions } from "./harness";

export type RealHostOptions = {
  /** The workspace root (default examples/nano-vllm) */
  root?: string;
  /** The page options of every board the host opens (theme, size, a scenario's own replies in front of the host: `on`) */
  page?: Omit<OpenOptions, "board" | "via">;
  /** A modal warning (a confirm, Delete Board…): the button the user picks; by default the first one (OK) */
  warn?: (text: string, actions: string[]) => string | undefined;
  /** Runs before a board switch's init (entering or leaving a sub-board) reaches the page: the board is mid-transition */
  beforeSwitch?: () => Promise<void>;
  /** Changes what the host answered a request before the page gets it (e.g. an extra name hit) */
  reply?: (ask: BoardToHost, data: unknown) => unknown;
};

export type RealHostRun = {
  host: RealHost;
  ws: TestWorkspace;
  /** Every init a page got: the board, how deep in the crumbs, the walkthrough hop it carried */
  inits: { id: string; crumbs: number; walk?: unknown }[];
  /** Opens the board in a page (the host's own Open Board), or brings its page forward */
  open(id: string): Promise<Host>;
  /** The page of an open board, by the board it shows now */
  page(id: string): Host | undefined;
  /** The boards whose page the host brought forward (opening a board that is open already) */
  revealed: string[];
  /** A card for a symbol of a file under the root, made as Add Function makes it (nth: which of several with that name) */
  card(rel: string, qual: string, nth?: number): Promise<CodeCard>;
  /** A request the first open board could make, answered by the host's message handler without a page round trip */
  ask<T extends AskType>(m: Omit<Extract<BoardToHost, { type: T }>, "req">): Promise<ReplyOf<T>>;
  /** Disposes the host and writes what its storage still holds (also done after the scenario) */
  close(): Promise<void>;
};

let runs = 0;

/**
 * The editor's keybindings for keys the board forwards to its host (FORWARDED_KEYS): the chord of this platform ("ctrl+shift+b",
 * on a Mac "cmd+shift+b") → the codeboard.boardKey action. They live in the extension's package.json, which VS Code reads; the
 * harness page plays that part
 */
const MAC = process.platform === "darwin";
const BOARD_KEYS: Record<string, string> = Object.fromEntries(
  (
    JSON.parse(fs.readFileSync(path.join(REPO, "extensions/vscode/package.json"), "utf8")).contributes.keybindings as {
      command: string;
      key: string;
      mac?: string;
      args?: string;
    }[]
  )
    .filter((k) => k.command === "codeboard.boardKey")
    .map((k) => [MAC ? (k.mac ?? k.key) : k.key, k.args!]),
);

/** What the scenario's fixtures give the host: opening a page (checked and closed with the scenario), a teardown, a failed check */
export type Harness = {
  openPage: (o: OpenOptions) => Promise<Host>;
  afterTest: (fn: () => Promise<void>) => void;
  fail: (check: string, detail: string) => void;
};

/** Starts the real host with these boards saved in its storage; fixtures.ts hostBoards() is the way in from a scenario */
export async function realHost(boards: Board[], t: Harness, o: RealHostOptions = {}): Promise<RealHostRun> {
  // one per worker and run: workers run side by side, and a scenario's late writes must not reach the next one's boards
  const dir = path.join(OUT, `realhost-${process.pid}-${++runs}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = nodeWorkspace(o.root ?? path.join(REPO, "examples/nano-vllm"));
  const state = new Map<string, unknown>(),
    global = new Map<string, unknown>();
  ws.storage = {
    dir: () => dir,
    globalDir: () => path.join(dir, "global"),
    get: <T>(k: string) => state.get(k) as T | undefined,
    set: async (k, v) => void state.set(k, v),
  };
  ws.ui = { ...ws.ui, warn: async (text, _o, ...actions) => (o.warn ? o.warn(text, actions) : actions[0]) };

  const views: PageView[] = [];
  /** The page last pressed or opened: the editor's active board (the one a keybinding runs on) */
  let front: PageView | undefined;
  const inits: RealHostRun["inits"] = [];
  const revealed: string[] = [];
  const env: HostEnv = {
    globalState: { get: <T>(k: string) => global.get(k) as T | undefined, set: async (k, v) => void global.set(k, v) },
    openView: () => {
      const v = new PageView();
      views.push(v);
      front = v;
      v.opened = t
        .openPage({
          ...o.page,
          via: { send: (m, post) => v.receive(m, post), board: () => host.store.peek(panelOf(v)?.id ?? "")! },
          // like VS Code's webview, which hands every keydown to the workbench: a chord the extension binds runs its command
          beforeLoad: async (page) => {
            await page.exposeFunction("__key", (chord: string) => {
              const action = BOARD_KEYS[chord];
              front = v;
              if (action) void host.actions["codeboard.boardKey"](action as never);
            });
            await page.addInitScript(
              (mac) =>
                addEventListener("keydown", (e) => {
                  if (!(mac ? e.metaKey : e.ctrlKey)) return;
                  const k = e.key === "+" ? "=" : e.key.toLowerCase();
                  (window as any).__key(`${mac ? "cmd" : "ctrl"}+${e.shiftKey ? "shift+" : ""}${k}`);
                }),
              MAC,
            );
            await o.page?.beforeLoad?.(page);
          },
        })
        .then((h) => (v.h = h));
      return v;
    },
  };
  const host = startHost(ws, env);
  // the name index complete before the first board opens (the host builds it in the background): a call resolves the same every run
  host.hub.cx.index.start();
  await host.hub.cx.index.ready();
  const panelOf = (v: PageView) => host.hub.all().find((p) => p.view === v);

  class PageView implements BoardView {
    title = "";
    visible = true;
    get active() {
      return front === this;
    }
    h: Host | undefined;
    opened!: Promise<Host>;
    private message = new Emitter<BoardToHost>();
    private activate = new Emitter<void>();
    private disposed = new Emitter<void>();
    readonly onMessage = this.message.event;
    readonly onDidActivate = this.activate.event;
    readonly onDidDispose = this.disposed.event;
    private post: ((m: HostToBoard) => Promise<void>) | undefined;
    /** What the host posted, in order: a page post at a time */
    private out: Promise<void> = Promise.resolve();
    private replies = new Map<number, () => void>();
    private asks = new Map<number, BoardToHost>();
    private ready: (() => void)[] = [];
    private inited = false;
    private gone = false;

    postMessage(m: HostToBoard) {
      const ask = m.type === "reply" ? this.asks.get(m.req) : undefined;
      if (m.type === "reply" && ask && o.reply) m = { ...m, data: o.reply(ask, m.data) as never };
      this.out = this.out.then(async () => {
        if (m.type === "init" && this.inited) await o.beforeSwitch?.();
        if (this.gone || !this.post) return;
        try {
          await this.post(m);
        } catch (e) {
          if (!this.h?.page.isClosed()) throw e;
        }
        if (m.type === "init") {
          this.inited = true;
          inits.push({ id: m.board.id, crumbs: m.crumbs?.length ?? 0, walk: m.walk });
          for (const r of this.ready.splice(0)) r();
        }
        if (m.type === "reply") {
          this.replies.get(m.req)?.();
          this.replies.delete(m.req);
          this.asks.delete(m.req);
        }
      });
    }
    /** A message from the page: resolves once the host has answered it (its init, its reply), as idle() expects */
    async receive(m: BoardToHost & { req?: number }, post: (m: HostToBoard) => Promise<void>) {
      this.post = post;
      const answered =
        m.type === "ready"
          ? new Promise<void>((r) => this.ready.push(r))
          : m.req !== undefined
            ? new Promise<void>((r) => {
                this.replies.set(m.req!, r);
                this.asks.set(m.req!, m);
              })
            : undefined;
      this.message.fire(m);
      await answered;
      // every version of the board the host keeps must load back through loadBoard (the schema), as with the fixture host
      const b = m.type === "patch" && host.store.peek(panelOf(this)?.id ?? "");
      if (b)
        try {
          loadBoard(structuredClone(b));
        } catch (e) {
          t.fail("board-schema", (e as Error).message);
        }
    }
    reveal() {
      const p = panelOf(this);
      if (p) revealed.push(p.id);
    }
    async focus() {}
    dispose() {
      if (this.gone) return;
      this.gone = true;
      this.disposed.fire();
    }
    resourceUrl(dir: string) {
      return `file://${dir}`;
    }
  }

  for (const b of boards) await host.store.save(b);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const v of views) v.dispose();
    host.dispose();
    await host.flush();
  };
  t.afterTest(close);
  await host.ready;
  return {
    host,
    ws,
    inits,
    revealed,
    async open(id) {
      const p = await host.hub.show(id);
      if (!p) throw new Error(`realHost: no board ${id}`);
      return (p.view as PageView).opened;
    },
    page: (id) => (host.hub.get(id)?.view as PageView | undefined)?.h,
    async ask(m) {
      const p = host.hub.all()[0];
      if (!p) throw new Error("realHost: ask needs an open board");
      return (await host.hub.handler(p, { ...m, req: 0 } as BoardToHost)) as never;
    },
    card: (rel, qual, nth) => symbolCard(host.hub.cx, path.join(ws.files.roots()[0], rel), qual, nth),
    close,
  };
}
