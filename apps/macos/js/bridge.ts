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
  estSize,
  type Rect,
  sectionFrames,
  type SharedUpdate,
  layoutSummaries,
  summaryOf,
  summarySources,
} from "@codeboard/core";
import { dropCards, dropGone, resizePlace } from "@codeboard/core/commands";
import { createHistory, createSave, type Doc } from "@codeboard/core/history";
import { type Fs, Storage } from "@codeboard/host/storage";
import { noteBlocks } from "@yhnocoder/markdown";
import { nativeFs } from "./fs";
import { commands, makeEnv } from "./commands";
import { makeHighlighter } from "./highlight";
import { installGlobals, isErr, type Native } from "./native";
import type { Mode } from "@codeboard/core/canvas";
import { type Rect as DrawnRect, type RouteGeo, routeModel, Router } from "./routes";
import {
  type Scene,
  type SceneCard,
  type SceneChange,
  type SceneEnv,
  scene,
  sceneCard,
  sceneLink,
  sceneSection,
  sceneSticker,
  sectionRects,
} from "./scene";

/** The camera coming to rest is saved after this long (the board's LIVE_DELAY); a failed save is sent again after RESEND_DELAY */
const LIVE_DELAY = 800,
  RESEND_DELAY = 2000;

type Snap = ReturnType<ReturnType<typeof createHistory>["snap"]>;

/** One open board: what a window (a view onto it) can do; two windows on one board share the session */
/** The summary level as the shell draws it (core SumLayout, each column with its text) */
export type SumScene = {
  S: number;
  P: number;
  cut: number;
  cols: {
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
    hd: number;
    title: string;
    text: string;
    head?: 1 | 2;
    kick?: string;
    code?: { name: string; at: string };
  }[];
};
export interface Session {
  readonly id: string;
  board(): Board;
  /** The whole scene, as the shell draws it when it shows the board; changes() then diffs from here */
  scene(): Promise<Scene>;
  /** What changed since the shell last got the scene (or the whole scene): items to put in, ids gone */
  changes(): Promise<SceneChange>;
  summaries(): SumScene;
  synced(fn: (b: Board) => void, keys?: string[]): void;
  syncShared(cards: SharedUpdate[]): void;
  route(rects: Record<string, DrawnRect>, only?: string[], modes?: Record<string, Mode>): RouteGeo[];
  beginDrag(): void;
  drag(moves: { id: string; x: number; y: number }[]): void;
  endDrag(moves: (DrawnRect & { id: string })[]): Promise<SceneChange>;
  undo(): Promise<SceneChange>;
  redo(): Promise<SceneChange>;
  cam(c: Camera): void;
  /** A card resized by its edge or corner (inside a drag gesture): width, and a height ("keep" = as it is, null = back to
   *  following the content) */
  resize(id: string, w: number, h: number | null | "keep"): void;
  /** The edits (commands.ts), each followed by changes() for the shell */
  cmd: ReturnType<typeof commands>;
  /** The board is gone from storage: this session writes nothing more */
  kill(): void;
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
        s = makeSession(dir, storage, b, env, (gone) => {
          // a sub-board an undo took back: a session on it (a window had it open) must not write it again
          sessions.get(gone)?.kill();
          sessions.delete(gone);
        });
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
  function makeSession(dir: string, storage: Storage, loaded: Board, env: SceneEnv, dropped: (id: string) => void): Session {
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
    /** The board was dropped (an undone Turn into Board): nothing of it is written any more */
    let dead = false;
    const save = createSave({
      loaded: () => true,
      snap: history.snap,
      cam: () => board.cam,
      takeUndone: history.takeUndone,
      post: async (patch, undo) => {
        if (dead) return { skipped: 0 };
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
    /** Each link the shell has, by id → the card it starts from (a gone link's card is sent again for its row tints) */
    const linkFrom = new Map(loaded.links.map((l) => [l.id, l.from.card]));

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
      const out: SceneChange = {
        cards: [],
        sections: [],
        links: [],
        stickers: [],
        gone: { cards: [], sections: [], links: [], stickers: [] },
        moved: [],
      };
      const map = (ids: string[], xs: string[]) => new Map(ids.map((k, i) => [k, xs[i]]));
      const wc = map(was.ids.cards, was.cards),
        nc = map(now.ids.cards, now.cards);
      const wp = map(was.ids.place, was.place),
        np = map(now.ids.place, now.place);
      for (const [k, s] of nc) {
        if (!np.has(k)) continue; // a Compare's column: not on the canvas
        if (wc.get(k) === s && wp.get(k) !== np.get(k)) {
          // only its position (and Section) changed: the shell moves the layer; anything else of the place rebuilds the card
          const p = board.place[k];
          const [, was] = JSON.parse(wp.get(k)!) as [string, typeof p];
          const { x: _x, y: _y, section: _s, ...rest } = p;
          const { x: _wx, y: _wy, section: _ws, ...wrest } = was;
          if (JSON.stringify(rest) === JSON.stringify(wrest)) {
            out.moved.push(p.section ? { id: k, x: p.x, y: p.y, section: p.section } : { id: k, x: p.x, y: p.y });
            continue;
          }
        }
        if (wc.get(k) !== s || wp.get(k) !== np.get(k)) {
          const c = board.cards.find((x) => x.id === k);
          const sc = c && (await sceneCard(board, c, env));
          if (sc) out.cards.push(sc);
        }
      }
      for (const k of wc.keys()) if (!nc.has(k) || !np.has(k)) out.gone.cards.push(k);
      // a code card's head counts its sidenotes: when any changed, every code card with one goes again (few, rare)
      if (was.sidenotes !== now.sidenotes && was.sidenotes.join() !== now.sidenotes.join())
        for (const c of board.cards)
          if (c.kind === "code" && !out.cards.some((x) => x.id === c.id) && np.has(c.id)) {
            const sc = await sceneCard(board, c, env);
            if (sc) out.cards.push(sc);
          }
      const ws = map(was.ids.sections, was.sections),
        ns = map(now.ids.sections, now.sections);
      // a Section's frame follows its members: when a card moved or changed, every Section is sent again (they are few)
      const cardsMoved = out.cards.length > 0 || out.gone.cards.length > 0 || out.moved.length > 0;
      // stickers: few; one bound to a card moves with it, so any card change sends them all again
      const wk = map(was.ids.stickers, was.stickers),
        nk = map(now.ids.stickers, now.stickers);
      for (const [k, s] of nk)
        if (cardsMoved || wk.get(k) !== s) {
          const st = sceneSticker(board, board.stickers.find((x) => x.id === k)!);
          if (st) out.stickers.push(st);
          else if (wk.has(k)) out.gone.stickers.push(k);
        }
      for (const k of wk.keys()) if (!nk.has(k)) out.gone.stickers.push(k);
      for (const [k, s] of ns)
        if (cardsMoved || ws.get(k) !== s)
          out.sections.push(sceneSection(board, board.sections.find((x) => x.id === k)!));
      for (const k of ws.keys()) if (!ns.has(k)) out.gone.sections.push(k);
      const wl = map(was.ids.links, was.links),
        nl = map(now.ids.links, now.links);
      // a code card tints the rows its arrows start from (SceneSegment.from): a changed or gone link sends its card again too
      const relinked = new Set<string>();
      for (const [k, s] of nl)
        if (wl.get(k) !== s) {
          const l = board.links.find((x) => x.id === k)!;
          out.links.push(sceneLink(board, l));
          relinked.add(l.from.card);
        }
      for (const k of wl.keys())
        if (!nl.has(k)) {
          out.gone.links.push(k);
          router.forget(k);
          const from = linkFrom.get(k);
          if (from) relinked.add(from);
        }
      linkFrom.clear();
      for (const l of board.links) linkFrom.set(l.id, l.from.card);
      for (const id of relinked) {
        if (out.cards.some((c) => c.id === id)) continue;
        const c = board.cards.find((x) => x.id === id && x.kind === "code");
        const sc = c && (await sceneCard(board, c, env));
        if (sc) out.cards.push(sc);
      }
      if (was.head !== now.head) out.name = board.name;
      if (out.cards.length || out.links.length || out.gone.cards.length || out.gone.links.length)
        out.routing = routeModel(board);
      return out;
    }

    // A drag: live changes, one undo step when it ends; the drop joins the Section the card lies in (core's dropCards, what the
    // web board's drop does too)
    let gesture: ((record?: boolean) => void) | null = null;

    return {
      id,
      board: () => board,
      /** Quick: Code cards whose grammar is still loading come back `pending`, and follow as a change once it is there */
      async scene(): Promise<Scene> {
        shown = history.snap();
        const s = await scene(board, env, true);
        const pending = s.cards.filter((c) => c.pending).map((c) => c.id);
        if (pending.length) {
          void hl.ready().then(async () => {
            const cards: SceneCard[] = [];
            for (const id of pending) {
              const c = board.cards.find((x) => x.id === id);
              const sc = c && (await sceneCard(board, c, env));
              if (sc) cards.push(sc);
            }
            emit("changed", {
              dir,
              id,
              change: {
                cards,
                sections: [],
                links: [],
                stickers: [],
                gone: { cards: [], sections: [], links: [], stickers: [] },
                moved: [],
              },
            });
          });
        }
        return s;
      },
      changes,
      /** The zoomed-out summary level (core summary.ts): the layout and each column's text, for the shell to draw */
      summaries(): SumScene {
        const rects = new Map<string, Rect>();
        for (const c of board.cards) {
          const p = board.place[c.id];
          if (p) rects.set(c.id, { x: p.x, y: p.y, w: p.w, h: estSize(c, p).h });
        }
        const lay = layoutSummaries(summarySources(board, (id) => rects.get(id), sectionRects(board)));
        return {
          S: lay.S,
          P: lay.P,
          cut: lay.cut,
          cols: lay.cols.map((c) => ({
            key: c.key,
            x: c.x,
            y: c.y,
            w: c.w,
            h: c.h,
            hd: c.hd,
            title: c.title,
            text: summaryOf(board, c.key)?.text ?? "",
            ...(c.head ? { head: c.head.level } : {}),
            ...(c.kick ? { kick: c.kick } : {}),
            ...(c.code ? { code: c.code } : {}),
          })),
        };
      },
      synced,
      syncShared,
      route: (rects, only, modes) => router.route(routeModel(board), rects, only, modes),
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
        // the Section frames as drawn around the cards that stay (a dragged card does not stretch the frame it is leaving)
        const moved = new Set(moves.map((m) => m.id));
        const rects = new Map<string, Rect>(
          board.cards
            .filter((c) => board.place[c.id] && !moved.has(c.id))
            .map((c) => [c.id, { x: board.place[c.id].x, y: board.place[c.id].y, ...estSize(c, board.place[c.id]) }]),
        );
        const fr = sectionFrames(board, rects);
        if (gesture) history.live((b) => dropCards(b, moves, fr));
        gesture?.();
        gesture = null;
        return changes();
      },
      undo: () => (history.undo(), changes()),
      redo: () => (history.redo(), changes()),
      cam: (c: Camera) => history.liveCam(c),
      // a locked card stays; a Compare's column resizes its Compare (the board's hostPlace)
      resize(card, w, h) {
        history.live((b) => void resizePlace(b, card, w, h));
      },
      cmd: commands(
        makeEnv(history, () => board, {
          toast: (text) => emit("toast", { dir, id, text }),
          choose: (title, options, text) => new Promise((res) => native.choose(title, options, text ?? "", res)),
          storage,
          dropped,
        }),
        () => storage,
      ),
      flushSave: () => {
        if (!dead) save.flush();
      },
      kill: () => {
        dead = true;
      },
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
