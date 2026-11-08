// The bridge: one per process. It holds one Storage per boards folder (`folder(dir)`, shared by every window on that folder: board
// windows, the library) and, inside a folder, one session per open board (`folder.open(id)`): the board, core's undo engine
// (history), its saving, its arrow router and the snapshot the shell's scene was built from. A window is a view onto a session;
// two windows on one board share it. The shell calls the methods below (JSBridge.swift: strings in, JSON strings out) and gets
// events through native.emit, each naming its folder and board. Every change to a board goes through core's history: a drag is a
// gesture (one undo step when it ends), undo / redo replay the host's syncs, and saving sends Storage the same patches the web
// board sends its host.
import {
  applyPatch,
  applySharedUpdate,
  type Board,
  type BoardMeta,
  type Camera,
  emptyBoard,
  type Rect,
  type SharedUpdate,
} from "@codeboard/core";
import { dropCards, dropGone } from "@codeboard/core/commands";
import { createHistory, createSave, type Doc } from "@codeboard/core/history";
import { type Fs, Storage } from "@codeboard/host/storage";
import { noteBlocks } from "@yhnocoder/markdown";
import { nativeFs } from "./fs";
import { makeHighlighter } from "./highlight";
import { installGlobals, isErr, type Native } from "./native";
import { type Rect as DrawnRect, type RouteGeo, Router } from "./routes";
import { type Scene, type SceneChange, type SceneEnv, scene, sceneCard, sceneLink, sceneSection } from "./scene";

/** The camera coming to rest is saved after this long (the board's LIVE_DELAY); a failed save is sent again after RESEND_DELAY */
const LIVE_DELAY = 800,
  RESEND_DELAY = 2000;

type Snap = ReturnType<ReturnType<typeof createHistory>["snap"]>;

/** One open board: what a window (a view onto it) can do; two windows on one board share the session */
export interface Session {
  readonly id: string;
  board(): Board;
  /** The whole scene, as the shell draws it when it shows the board; changes() then diffs from here */
  scene(): Promise<Scene>;
  /** What changed since the shell last got the scene (or the whole scene): items to put in, ids gone */
  changes(): Promise<SceneChange>;
  synced(fn: (b: Board) => void, keys?: string[]): void;
  syncShared(cards: SharedUpdate[]): void;
  route(rects: Record<string, DrawnRect>, only?: string[]): RouteGeo[];
  beginDrag(): void;
  drag(moves: { id: string; x: number; y: number }[]): void;
  endDrag(moves: (DrawnRect & { id: string })[]): Promise<SceneChange>;
  undo(): Promise<SceneChange>;
  redo(): Promise<SceneChange>;
  cam(c: Camera): void;
  flushSave(): void;
  /** Core's raw access, for the gate measurements and tests */
  mutate(fn: (b: Board) => void): boolean;
}

/** timers: false = the shell's timers are not installed as the globals (the tests run on Node's own); wasmDir = the tree-sitter
 *  grammars (the app's Resources); none = C / C++ / CUDA stay plain */
export function createBridge(native: Native, opts: { fs?: Fs; timers?: boolean; wasmDir?: string } = {}) {
  const fs = opts.fs ?? nativeFs(native);
  const globals = opts.timers === false ? { fire: (_id: number) => {} } : installGlobals(native);
  const emit = (name: string, data: Record<string, unknown>) => native.emit(name, JSON.stringify(data));
  const hl = makeHighlighter((file) => {
    const r = native.readBinary(`${opts.wasmDir ?? ""}/${file}`);
    return isErr(r) ? Promise.reject(new Error(r.error)) : Promise.resolve(fs.fromBase64(r));
  });
  const watches = new Map<number, (abs: string) => void>();
  const folders = new Map<string, Folder>();

  // MARK: a folder: its Storage, watched the way the extension does, and the sessions of its open boards
  type Folder = ReturnType<typeof makeFolder>;
  function makeFolder(dir: string) {
    const sessions: Map<string, Session> = new Map();
    const storage = new Storage(fs, {
      dir: () => dir,
      log: (level, text) => emit("log", { dir, level, text }),
      // cameras in the shell's store (one per process, every window's)
      cams: {
        get: (id) => {
          const s = native.camGet(id);
          return s ? (JSON.parse(s) as Camera) : undefined;
        },
        set: (id, cam) => native.camSet(id, JSON.stringify(cam)),
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
    storage.onDidChange(() => void storage.list().then((boards) => emit("boards", { dir, boards })));
    storage.onDidMerge(({ id, patch }) => sessions.get(id)?.synced((b) => applyPatch(b, structuredClone(patch))));
    // the board that wrote takes only `back` (its card file was changed by another window, those items merged in); the others
    // the cards they have (host hub.ts)
    storage.onDidShare(({ from, cards, back }) => {
      for (const s of sessions.values()) {
        const mine = (from === s.id ? (back ?? []) : cards).filter((sc) =>
          s.board().cards.some((c) => c.id === sc.card.id),
        );
        if (mine.length) s.syncShared(mine);
      }
    });
    storage.onDidRemoveShared(({ card }) => {
      for (const s of sessions.values())
        if (s.board().cards.some((c) => c.id === card)) s.synced((b) => dropGone(b, [card]));
    });
    storage.onDidFailSave(({ error }) => emit("toast", { dir, text: `Couldn't save the board: ${error}` }));
    const env: SceneEnv = { assetsDir: `${dir}/assets`, peek: (id) => storage.peek(id) ?? null, hl };

    return {
      dir,
      storage,
      sessions,
      list: (): Promise<BoardMeta[]> => storage.list(),
      /** The board's session, made on first open (loaded from Storage) */
      async open(id: string): Promise<Session | null> {
        let s = sessions.get(id);
        if (s) return s;
        const b = await storage.load(id);
        if (!b) return null;
        s = makeSession(dir, storage, b, env);
        sessions.set(id, s);
        return s;
      },
      /** Unsaved changes written: one board's, or all */
      async flush(id?: string) {
        for (const s of id ? [sessions.get(id)] : sessions.values()) s?.flushSave();
        await storage.flush();
      },
      /** The last window on this folder closed: nothing more is watched or written */
      async close() {
        await this.flush();
        storage.dispose();
        folders.delete(dir);
      },
    };
  }
  function folder(dir: string): Folder {
    let f = folders.get(dir);
    if (!f) folders.set(dir, (f = makeFolder(dir)));
    return f;
  }

  // MARK: a session: one open board, with core's history and saving
  function makeSession(dir: string, storage: Storage, loaded: Board, env: SceneEnv): Session {
    const id = loaded.id;
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
        stacks: (undo, redo) => emit("stacks", { dir, id, undo, redo }),
        restored: () => {},
        toast: (text) => emit("toast", { dir, id, text }),
      },
      { noteBlocks, selfCheck: false },
    );
    const save = createSave({
      loaded: () => true,
      snap: history.snap,
      cam: () => board.cam,
      takeUndone: history.takeUndone,
      post: async (patch, undo) => {
        const skipped = await storage.patch(id, patch, { undo });
        // shared items an undo skipped: Storage kept the other board's version, this board takes it back (host handlers.ts)
        if (skipped.length) syncShared(skipped);
        return { skipped: skipped.length };
      },
      toast: (text) => emit("toast", { dir, id, text }),
      liveDelay: LIVE_DELAY,
      resendDelay: RESEND_DELAY,
    });
    const router = new Router();
    history.setBoard(loaded, []);
    save.markSaved();
    /** The snapshot the scene the shell has was built from: changes() diffs against it */
    let shown: Snap = history.snap();

    // The host changed the board itself: what is not sent yet goes out first, then "sent" is aligned to now, so these are not
    // sent back. They are syncs: no undo step, replayed after undo (the web board's state/changes.ts syncShared / syncGone /
    // syncMerged)
    function synced(fn: (b: Board) => void, keys?: string[]) {
      save.flush();
      history.sync(fn, keys);
      save.alignSent();
      void changes().then((change) => emit("changed", { dir, id, change }));
    }
    function syncShared(cards: SharedUpdate[]) {
      const keys = cards.flatMap((sc) => sc.items.map((k) => (k === sc.card.id ? `c${k}` : `n${k}`)));
      synced((b) => {
        for (const sc of cards) applySharedUpdate(b, sc);
      }, keys);
    }

    /** What changed since the shell last got the scene: the items to put in and the ids gone. One at a time: each diff starts from
     *  the snapshot the previous one ended at */
    let chain: Promise<unknown> = Promise.resolve();
    function changes(): Promise<SceneChange> {
      const p = chain.then(changesNow, changesNow);
      chain = p;
      return p;
    }
    async function changesNow(): Promise<SceneChange> {
      const now = history.snap();
      const was = shown;
      shown = now;
      const out: SceneChange = { cards: [], sections: [], links: [], gone: { cards: [], sections: [], links: [] } };
      const map = (ids: string[], xs: string[]) => new Map(ids.map((k, i) => [k, xs[i]]));
      const wc = map(was.ids.cards, was.cards),
        nc = map(now.ids.cards, now.cards);
      const wp = map(was.ids.place, was.place),
        np = map(now.ids.place, now.place);
      for (const [k, s] of nc) {
        if (!np.has(k)) continue; // a Compare's column: not on the canvas
        if (wc.get(k) !== s || wp.get(k) !== np.get(k)) {
          const c = board.cards.find((x) => x.id === k);
          const sc = c && (await sceneCard(board, c, env));
          if (sc) out.cards.push(sc);
        }
      }
      for (const k of wc.keys()) if (!nc.has(k) || !np.has(k)) out.gone.cards.push(k);
      const ws = map(was.ids.sections, was.sections),
        ns = map(now.ids.sections, now.sections);
      for (const [k, s] of ns)
        if (ws.get(k) !== s) out.sections.push(sceneSection(board.sections.find((x) => x.id === k)!));
      for (const k of ws.keys()) if (!ns.has(k)) out.gone.sections.push(k);
      const wl = map(was.ids.links, was.links),
        nl = map(now.ids.links, now.links);
      for (const [k, s] of nl)
        if (wl.get(k) !== s) out.links.push(sceneLink(board, board.links.find((x) => x.id === k)!));
      for (const k of wl.keys())
        if (!nl.has(k)) {
          out.gone.links.push(k);
          router.forget(k);
        }
      if (was.head !== now.head) out.name = board.name;
      return out;
    }

    // A drag: live changes, one undo step when it ends; the drop joins the Section the card lies in (core's dropCards, what the
    // web board's drop does too)
    let gesture: ((record?: boolean) => void) | null = null;

    return {
      id,
      board: () => board,
      scene(): Promise<Scene> {
        shown = history.snap();
        return scene(board, env);
      },
      changes,
      synced,
      syncShared,
      route: (rects: Record<string, DrawnRect>, only?: string[]): RouteGeo[] => router.route(board, rects, only),
      beginDrag() {
        gesture?.();
        gesture = history.beginGesture();
      },
      drag(moves: { id: string; x: number; y: number }[]) {
        history.live((b) => {
          for (const m of moves) {
            const p = b.place[m.id];
            if (p) {
              p.x = m.x;
              p.y = m.y;
            }
          }
        });
      },
      endDrag(moves: (DrawnRect & { id: string })[]): Promise<SceneChange> {
        const fr: Map<string, Rect> = new Map(board.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
        if (gesture) history.live((b) => dropCards(b, moves, fr));
        gesture?.();
        gesture = null;
        return changes();
      },
      undo: () => (history.undo(), changes()),
      redo: () => (history.redo(), changes()),
      cam: (c: Camera) => history.liveCam(c),
      flushSave: () => save.flush(),
      mutate: (fn) => history.mutate(fn),
    };
  }

  return {
    folder,
    /** Every folder's unsaved changes written (the app is quitting) */
    flushAll: () => Promise.all([...folders.values()].map((f) => f.flush())).then(() => {}),
    /** The shell's callbacks */
    timer: (id: number) => globals.fire(id),
    fsChanged: (id: number, abs: string) => {
      if (abs.endsWith(".json")) watches.get(id)?.(abs);
    },
  };
}
