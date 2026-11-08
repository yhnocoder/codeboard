// The bridge: @codeboard/core's board, undo engine (history) and saving, and the host's Storage, wired for a native shell. The
// shell calls the methods below (JSBridge.swift: strings in, JSON strings out) and gets events through native.emit. Every change
// to the board goes through core's history: a drag is a gesture (one undo step when it ends), undo / redo replay the host's syncs,
// and saving sends Storage the same patches the web board sends its host.
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
import { type Scene, type SceneChange, scene, sceneCard, sceneLink, sceneSection } from "./scene";

/** The camera coming to rest is saved after this long (the board's LIVE_DELAY); a failed save is sent again after RESEND_DELAY */
const LIVE_DELAY = 800,
  RESEND_DELAY = 2000;

type Snap = ReturnType<ReturnType<typeof createHistory>["snap"]>;

/** timers: false = the shell's timers are not installed as the globals (the tests run on Node's own); wasmDir = the tree-sitter
 *  grammars (the app's Resources); none = C / C++ / CUDA stay plain */
export function createBridge(native: Native, opts: { fs?: Fs; timers?: boolean; wasmDir?: string } = {}) {
  const fs = opts.fs ?? nativeFs(native);
  const globals = opts.timers === false ? { fire: (_id: number) => {} } : installGlobals(native);
  const emit = (name: string, data: unknown) => native.emit(name, JSON.stringify(data ?? null));
  const hl = makeHighlighter((file) => {
    const r = native.readBinary(`${opts.wasmDir ?? ""}/${file}`);
    return isErr(r) ? Promise.reject(new Error(r.error)) : Promise.resolve(fs.fromBase64(r));
  });
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
    post: async (patch, undo) => {
      const skipped = await storage!.patch(board.id, patch, { undo });
      // shared items an undo skipped: Storage kept the other board's version, this board takes it back (host handlers.ts "shared")
      if (skipped.length) syncShared(skipped);
      return { skipped: skipped.length };
    },
    toast: (text) => emit("toast", text),
    liveDelay: LIVE_DELAY,
    resendDelay: RESEND_DELAY,
  });

  // The host changed the board itself: what is not sent yet goes out first, then "sent" is aligned to now, so these are not sent
  // back. They are syncs: no undo step, replayed after undo (the web board's state/changes.ts syncShared / syncGone / syncMerged)
  function synced(fn: (b: Board) => void, keys?: string[]) {
    save.flush();
    history.sync(fn, keys);
    save.alignSent();
    void changes().then((c) => emit("changed", c));
  }
  function syncShared(cards: SharedUpdate[]) {
    const keys = cards.flatMap((sc) => sc.items.map((id) => (id === sc.card.id ? `c${id}` : `n${id}`)));
    synced((b) => {
      for (const sc of cards) applySharedUpdate(b, sc);
    }, keys);
  }

  // Storage, on the shell's file system, watching the folder the way the extension does; cameras in the shell's store (one per
  // process, every window's)
  let storage: Storage | null = null;
  let dir = "";
  const watches = new Map<number, (abs: string) => void>();
  function init(storageDir: string) {
    storage?.dispose();
    dir = storageDir;
    storage = new Storage(fs, {
      dir: () => dir,
      log: (level, text) => emit("log", { level, text }),
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
    storage.onDidChange(() => void list().then((l) => emit("boards", l)));
    storage.onDidMerge(({ id, patch }) => {
      if (id === board.id) synced((b) => applyPatch(b, structuredClone(patch)));
    });
    // the board that wrote takes only `back` (its card file was changed by another window, those items merged in); the others
    // the cards they have (host hub.ts)
    storage.onDidShare(({ from, cards, back }) => {
      const mine = (from === board.id ? (back ?? []) : cards).filter((sc) =>
        board.cards.some((c) => c.id === sc.card.id),
      );
      if (mine.length) syncShared(mine);
    });
    storage.onDidRemoveShared(({ card }) => {
      if (board.cards.some((c) => c.id === card)) synced((b) => dropGone(b, [card]));
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

  // A drag: live changes, one undo step when it ends; the drop joins the Section the card lies in (core's dropCards, what the web
  // board's drop does too)
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
  function endDrag(moves: (DrawnRect & { id: string })[]): Promise<SceneChange> {
    const fr: Map<string, Rect> = new Map(board.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
    if (gesture) history.live((b) => dropCards(b, moves, fr));
    gesture?.();
    gesture = null;
    return changes();
  }

  return {
    init,
    list,
    open,
    changes,
    route: (rects: Record<string, DrawnRect>, only?: string[]): RouteGeo[] => router.route(board, rects, only),
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
    /** The shell is done with this board: Storage's watchers go, nothing more is written */
    dispose: () => {
      storage?.dispose();
      storage = null;
    },
  };
}
