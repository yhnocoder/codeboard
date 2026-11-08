// The bridge: @codeboard/core's board, undo engine (history) and saving, and the host's Storage, wired for a native shell. The
// shell calls the methods below (JSBridge.swift: strings in, JSON strings out) and gets events through native.emit. Every change
// to the board goes through core's history: a drag is a gesture (one undo step when it ends), undo / redo replay the host's syncs,
// and saving sends Storage the same patches the web board sends its host.
import {
  applyPatch,
  applySharedUpdate,
  blockSig,
  type Board,
  type BoardMeta,
  type Camera,
  emptyBoard,
} from "@codeboard/core";
import { createHistory, createSave, type Doc } from "@codeboard/core/history";
import { dropGone } from "@codeboard/core/commands";
import { Storage, type Fs } from "@codeboard/host/storage";
import { nativeFs } from "./fs";
import { Highlight } from "./highlight";
import { installGlobals, type Native } from "./native";
import { Router, type Rect, type RouteGeo } from "./routes";
import { scene, sceneCard, sceneLink, sceneSection, type Scene, type SceneChange } from "./scene";

/** The camera coming to rest is saved after this long (the board's LIVE_DELAY); a failed save is sent again after RESEND_DELAY */
const LIVE_DELAY = 800,
  RESEND_DELAY = 2000;
const CAMS_DELAY = 500;

type Snap = ReturnType<ReturnType<typeof createHistory>["snap"]>;

/** A Note's top-level blocks, the way arrow ends on blocks are matched (blank lines apart; a fenced code block is one block) */
export function noteBlocks(md: string): string[] | null {
  const out: string[] = [];
  let cur: string[] = [],
    fence = false;
  const flush = () => {
    if (cur.length) out.push(blockSig(cur.join("\n")));
    cur = [];
  };
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim()) flush();
    else cur.push(line);
  }
  flush();
  return out;
}

/** timers: false = the shell's timers are not installed as the globals (the tests run on Node's own) */
export function createBridge(native: Native, opts: { fs?: Fs; timers?: boolean } = {}) {
  const fs = opts.fs ?? nativeFs(native);
  const globals = opts.timers === false ? { fire: (_id: number) => {} } : installGlobals(native);
  const emit = (name: string, data: unknown) => native.emit(name, JSON.stringify(data ?? null));
  const hl = new Highlight();
  const router = new Router();

  let board: Board = emptyBoard("none", "");
  const doc: Doc = {
    read: () => board,
    write: (fn) => fn(board),
    replace: (b) => {
      board = b;
    },
    putItems: (ops) => {
      for (const [k, at, v] of ops) {
        if (k === "place") board.place[at as string] = v as Board["place"][string];
        else (board[k] as unknown[])[at as number] = v;
      }
    },
    raw: (x) => x,
  };
  const history = createHistory(
    doc,
    {
      changed: () => save.changed(),
      changedLive: () => save.changedLive(),
      stacks: (undo, redo) => emit("stacks", { undo, redo }),
      restored: () => {},
      toast: (text) => emit("toast", text),
    },
    { noteBlocks, selfCheck: false },
  );
  let loaded = false;
  const save = createSave({
    loaded: () => loaded,
    snap: history.snap,
    cam: () => board.cam,
    takeUndone: history.takeUndone,
    post: (patch, undo) => storage!.patch(board.id, patch, { undo }).then((r) => ({ skipped: r.length })),
    toast: (text) => emit("toast", text),
    liveDelay: LIVE_DELAY,
    resendDelay: RESEND_DELAY,
  });

  // Storage, on the shell's file system, watching the folder the way the extension does
  let storage: Storage | null = null;
  let dir = "";
  let camsFile = "";
  let cams: Record<string, Camera> = {};
  let camsTimer: ReturnType<typeof setTimeout> | undefined;
  const watches = new Map<number, (abs: string) => void>();
  function init(storageDir: string, stateFile: string) {
    storage?.dispose();
    dir = storageDir;
    camsFile = stateFile;
    try {
      cams = JSON.parse(native.readFile(camsFile) as string) ?? {};
    } catch {
      cams = {};
    }
    storage = new Storage(fs, {
      dir: () => dir,
      log: (level, text) => emit("log", { level, text }),
      cams: {
        get: (id) => cams[id],
        set: (id, cam) => {
          cams[id] = cam;
          clearTimeout(camsTimer);
          camsTimer = setTimeout(() => native.writeFile(camsFile, JSON.stringify(cams), false), CAMS_DELAY);
        },
      },
      watch: (base, _glob, fn) => {
        const id = native.watch(base);
        watches.set(id, fn);
        return {
          dispose: () => {
            watches.delete(id);
            native.unwatch(id);
          },
        };
      },
    });
    storage.onDidChange(() => void list().then((l) => emit("boards", l)));
    storage.onDidMerge(({ id, patch }) => {
      if (id !== board.id) return;
      save.flush();
      history.sync((b) => applyPatch(b, structuredClone(patch)));
      save.alignSent();
      void changes().then((c) => emit("changed", c));
    });
    storage.onDidShare(({ from, cards }) => {
      if (from === board.id || !cards.some((sc) => board.cards.some((c) => c.id === sc.card.id))) return;
      save.flush();
      history.sync((b) => {
        for (const sc of cards) applySharedUpdate(b, sc);
      });
      save.alignSent();
      void changes().then((c) => emit("changed", c));
    });
    storage.onDidRemoveShared(({ card }) => {
      if (!board.cards.some((c) => c.id === card)) return;
      save.flush();
      history.sync((b) => dropGone(b, [card]));
      save.alignSent();
      void changes().then((c) => emit("changed", c));
    });
    storage.onDidFailSave(({ error }) => emit("toast", `Couldn't save the board: ${error}`));
  }

  const env = () => ({ assetsDir: `${dir}/assets`, peek: (id: string) => storage?.peek(id) ?? null, hl });

  async function list(): Promise<BoardMeta[]> {
    return storage ? storage.list() : [];
  }

  /** The snapshot the scene the shell has was built from: changes() diffs against it */
  let shown: Snap | null = null;

  async function open(id: string): Promise<Scene | null> {
    if (!storage) return null;
    await save.flush();
    const b = await storage.load(id);
    if (!b) return null;
    history.setBoard(b, []);
    loaded = true;
    save.markSaved();
    shown = history.snap();
    for (const l of b.links) router.forget(l.id);
    return scene(board, env());
  }

  /** What changed since the shell last got the scene: the items to put in and the ids gone */
  async function changes(): Promise<SceneChange> {
    const now = history.snap();
    const was = shown;
    shown = now;
    const e = env();
    const out: SceneChange = { cards: [], sections: [], links: [], gone: { cards: [], sections: [], links: [] } };
    if (!was) return out;
    const map = (ids: string[], xs: string[]) => new Map(ids.map((id, i) => [id, xs[i]]));
    const wc = map(was.ids.cards, was.cards),
      nc = map(now.ids.cards, now.cards);
    const wp = map(was.ids.place, was.place),
      np = map(now.ids.place, now.place);
    for (const [id, s] of nc) {
      if (!np.has(id)) continue; // a Compare's column: not on the canvas
      if (wc.get(id) !== s || wp.get(id) !== np.get(id)) {
        const c = board.cards.find((k) => k.id === id);
        const sc = c && (await sceneCard(board, c, e));
        if (sc) out.cards.push(sc);
      }
    }
    for (const id of wc.keys()) if (!nc.has(id) || !np.has(id)) out.gone.cards.push(id);
    const ws = map(was.ids.sections, was.sections),
      ns = map(now.ids.sections, now.sections);
    for (const [id, s] of ns)
      if (ws.get(id) !== s) out.sections.push(sceneSection(board.sections.find((k) => k.id === id)!));
    for (const id of ws.keys()) if (!ns.has(id)) out.gone.sections.push(id);
    const wl = map(was.ids.links, was.links),
      nl = map(now.ids.links, now.links);
    for (const [id, s] of nl)
      if (wl.get(id) !== s) out.links.push(sceneLink(board, board.links.find((k) => k.id === id)!));
    for (const id of wl.keys())
      if (!nl.has(id)) {
        out.gone.links.push(id);
        router.forget(id);
      }
    if (was.head !== now.head) out.name = board.name;
    return out;
  }

  // A drag: live changes, one undo step when it ends
  let gesture: ((record?: boolean) => void) | null = null;
  function beginDrag() {
    gesture?.();
    gesture = history.beginGesture();
  }
  function drag(moves: { id: string; x: number; y: number }[]) {
    history.live((b) => {
      for (const m of moves) {
        const p = b.place[m.id];
        if (p) {
          p.x = m.x;
          p.y = m.y;
        }
      }
    });
  }
  function endDrag(): Promise<SceneChange> {
    gesture?.();
    gesture = null;
    return changes();
  }

  return {
    init,
    list,
    open,
    changes,
    route: (rects: Record<string, Rect>, only?: string[]): RouteGeo[] => router.route(board, rects, only),
    beginDrag,
    drag,
    endDrag,
    undo: () => (history.undo(), changes()),
    redo: () => (history.redo(), changes()),
    cam: (c: Camera) => history.liveCam(c),
    flush: () => (storage ? save.flush() : undefined, storage?.flush() ?? Promise.resolve()),
    /** Core's raw access, for the gate measurements and tests */
    board: () => board,
    mutate: history.mutate,
    /** The shell's callbacks */
    timer: (id: number) => globals.fire(id),
    fsChanged: (id: number, abs: string) => {
      if (abs.endsWith(".json")) watches.get(id)?.(abs);
    },
  };
}
