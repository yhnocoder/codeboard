// The board's change and undo engine, on plain objects (no Solid): the board itself lives behind `Doc`, so the same engine runs on
// a Solid store (state/changes.ts) and on a plain object (test/unit/history.test.ts).
// Three kinds of change: mutate = the user's edits (undo steps); sync = what the host synced or the view derived (saved, not undo
// steps, replayed after undo / redo); live = changes during a drag (the whole gesture becomes one undo step when it ends).
import { danglingRefs, removeCards, type Board } from "@codeboard/core";
import { itemOps, parse, same, snapper, touched, type Effect, type ItemOp, type Snap } from "./snap";
import { stamp, upkeeper, type Raw } from "./upkeep";
import { trimLru } from "./lru";

/** Where the board lives */
export interface Doc {
  /** The board as plain data */
  read(): Board;
  /** Change it in place (`fn` may get a draft: read past it with `raw`) */
  write(fn: (b: Board) => void): void;
  /** Replace the whole board */
  replace(b: Board): void;
  /** Replace single items */
  putItems(ops: ItemOp[]): void;
  raw: Raw;
}

export interface Hooks {
  /** A change to save now */
  changed(): void;
  /** A change during a drag or a camera move: saved a little later */
  changedLive(): void;
  /** The undo / redo stacks changed */
  stacks(canUndo: boolean, canRedo: boolean): void;
  /** Undo / redo put an older board back */
  restored(): void;
  toast(text: string): void;
}

export const NOT_UNDONE = "Changed on another board; not undone.";
const UNDO_MAX = 300;
const SYNC_MAX = 2000;
/** Boards whose undo history is kept besides the breadcrumbs */
const RECENT_HISTORIES = 4;

export function createHistory(doc: Doc, hooks: Hooks) {
  const snaps = snapper();
  const upkeep = upkeeper(doc.raw);
  const undoStack: Snap[] = [];
  const redoStack: Snap[] = [];
  // The current board's snapshot: the one a mutate took after its change is the next mutate's "before". Every write drops it,
  // so each mutate takes one snapshot, not two
  let cur: Snap | null = null;
  /** The current board as a snapshot (kept until the next write) */
  function snap(): Snap {
    return (cur ??= snapNow());
  }
  const snapNow = () => snaps.take(doc.read(), syncN);
  const stacks = () => hooks.stacks(undoStack.length > 0, redoStack.length > 0);

  function reseeTwins() {
    upkeep.reset();
    doc.write(upkeep.run);
  }

  /**
   * One undoable change: `fn` changes the board in place. When it throws the whole change is put back and false returned; a
   * change that changed nothing is no undo step. fx = what this step does outside the board, undone / redone with it; merge:
   * same as the top step's merge (no other change or undo between) → folded into it, like held arrow keys moving the same cards
   */
  function mutate(fn: (b: Board) => void, opts: { merge?: string; fx?: Effect } = {}): boolean {
    const before = snap();
    cur = null;
    try {
      doc.write((b) => {
        fn(b);
        upkeep.run(b);
        stamp(b, doc.raw);
      });
    } catch (e) {
      // the draft is half changed: put the whole board back, no half-changed board is left
      restore(before);
      console.error("mutate failed", e);
      hooks.toast("Something went wrong; the change was undone.");
      return false;
    }
    const bad = danglingRefs(doc.read());
    if (bad.length) console.warn("[codeboard] dangling references after a change:", bad); // self-check: always empty, the harness fails on it
    const after = snapNow();
    if (same(after, before)) {
      cur = before;
      return true;
    }
    cur = after;
    hooks.changed();
    pushUndo(before, after, opts);
    return true;
  }

  /** The top step's merge (see mutate): cleared by any other change and by undo / redo */
  let topMerge: string | undefined;
  function pushUndo(before: Snap, after: Snap, { merge, fx }: { merge?: string; fx?: Effect } = {}) {
    const top = undoStack[undoStack.length - 1];
    if (merge && merge === topMerge && top) {
      top.step = touched(top, after);
      redoStack.length = 0;
      stacks();
      return;
    }
    topMerge = merge;
    before.step = touched(before, after);
    before.fx = fx;
    undoStack.push(before);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
    stacks();
  }

  // A new Note / Text / Code / question with nothing written yet: making it is not an undo step yet. Content written → "new +
  // content" is one undo step; blurred with nothing written → it goes away (drop), as if it never was
  const fresh = new Map<string, { before: Snap; drop: (b: Board) => void }>();
  function createFresh(id: string, fn: (b: Board) => void, drop = (b: Board) => removeCards(b, [id])) {
    const before = snap();
    live(fn);
    fresh.set(id, { before, drop });
  }
  /** The first edit of a new card ends: keep = content was written (`fn` writes it) */
  function settleFresh(id: string, keep: boolean, fn?: (b: Board) => void) {
    const f = fresh.get(id);
    if (!f) return;
    fresh.delete(id);
    if (!keep) {
      live(f.drop);
      return;
    }
    live((b) => {
      fn?.(b);
      stamp(b, doc.raw);
    });
    pushUndo(f.before, snap());
    hooks.changed();
  }

  /** Snapshots taken when a drag began: not on the undo stack yet, but will be, so the syncs after them are kept */
  const held = new Set<Snap>();
  /** A continuous change (a drag): one undo step when it ends, if it changed anything (record = false: none, e.g. fresh cards moved) */
  function beginGesture(): (record?: boolean) => void {
    const before = snap();
    held.add(before);
    return (record = true) => {
      held.delete(before);
      const after = snap();
      if (record && !same(after, before)) {
        pushUndo(before, after);
        hooks.changed();
      }
    };
  }
  /** A change during a drag (no undo step) */
  function live(fn: (b: Board) => void) {
    cur = null;
    doc.write((b) => {
      fn(b);
      upkeep.run(b);
    });
    hooks.changedLive();
  }
  /** The camera came to rest. Snapshots have no camera, so the cached one stays valid and saving sends only the camera */
  function liveCam(c: Board["cam"]) {
    doc.write((b) => {
      b.cam = c;
    });
    hooks.changedLive();
  }

  // Syncs, replayed after undo / redo. Only those after the oldest snapshot in the stacks are kept, at most SYNC_MAX.
  // shared = shared items another board changed ("c" / "n" + id): replaying them after an undo means that item is not undone
  let syncLog: { n: number; fn: (b: Board) => void; shared?: string[] }[] = [];
  let syncN = 0;
  /**
   * What the host synced or the view derived (code moved a few lines, web page info, after a theme's reflow): written and saved,
   * not an undo step. Undo / redo back to a snapshot before it runs `fn` again, so `fn` must work on an older board: find by id
   * and skip what is gone, aim at absolute targets (not += the last delta)
   */
  function sync(fn: (b: Board) => void, shared?: string[]) {
    cur = null;
    doc.write((b) => {
      fn(b);
      upkeep.run(b);
      stamp(b, doc.raw);
    });
    syncLog.push({ n: ++syncN, fn, shared });
    trimSync();
    hooks.changed();
  }
  function trimSync() {
    let min = syncN;
    for (const s of undoStack) min = Math.min(min, s.epoch);
    for (const s of redoStack) min = Math.min(min, s.epoch);
    for (const f of fresh.values()) min = Math.min(min, f.before.epoch);
    for (const s of held) min = Math.min(min, s.epoch);
    let i = 0;
    while (i < syncLog.length && (syncLog[i].n <= min || syncLog.length - i > SYNC_MAX)) i++;
    if (i) syncLog.splice(0, i);
  }
  function replaySync(s: Snap): { any: boolean; shared: Set<string> } {
    const xs = syncLog.filter((x) => x.n > s.epoch);
    const shared = new Set(xs.flatMap((x) => x.shared ?? []));
    if (!xs.length) return { any: false, shared };
    doc.write((b) => {
      for (const x of xs) x.fn(b);
      upkeep.run(b);
    });
    return { any: true, shared };
  }

  // Undo / redo put back only the items that differ from now. Replacing the whole board parses and compares every card and link
  // (241 cards, 196 links: ~25 ms each time)
  function restore(s: Snap, now?: Snap) {
    cur = null;
    const ops = now && itemOps(now, s);
    if (ops) doc.putItems(ops);
    else doc.replace({ ...parse(s), cam: { ...doc.read().cam } });
    reseeTwins();
    // the host's syncs after the snapshot run again (or ⌘Z would move line numbers back); a replayed board is no longer the snapshot
    const r = replaySync(s);
    cur = r.any ? null : { ...s, epoch: syncN, step: undefined, fx: undefined };
    hooks.changed();
    // a shared item this step changed was changed on another board since: replaying their version means it was not undone
    if (s.step && r.shared.size && s.step.some((k) => r.shared.has(k))) hooks.toast(NOT_UNDONE);
    hooks.restored();
  }

  /** Set by undo / redo until the next save: the host then skips shared items another board changed since */
  let undone = false;
  function back(from: Snap[], to: Snap[], dir: "undo" | "redo") {
    const s = from.pop();
    if (!s) return false;
    topMerge = undefined;
    const now = snap();
    to.push({ ...now, fx: s.fx });
    undone = true;
    restore(s, now);
    s.fx?.[dir]();
    stacks();
    return true;
  }
  const undo = () => back(undoStack, redoStack, "undo");
  const redo = () => back(redoStack, undoStack, "redo");

  // Each board has its own undo history: entering a sub-board and coming back, the host sends this board again, and when it is
  // the same as when it was left, its history goes on. Each history holds a whole snapshot of its board: the breadcrumbs' boards
  // are all kept (going back up needs them), the others only for the RECENT_HISTORIES boards left last
  const histories = new Map<string, { undo: Snap[]; redo: Snap[]; sync: typeof syncLog; at: Snap }>();
  let loaded = false;
  /** Put in the board the host sent. crumbs = the boards above it */
  function setBoard(b: Board, crumbs: readonly string[]) {
    if (loaded) {
      const id = doc.read().id;
      histories.delete(id); // set again at the end: left last
      histories.set(id, { undo: undoStack.splice(0), redo: redoStack.splice(0), sync: syncLog, at: snapNow() });
      syncLog = [];
    }
    loaded = true;
    doc.replace(b);
    reseeTwins();
    cur = null;
    topMerge = undefined;
    snaps.reset();
    const h = histories.get(b.id);
    histories.delete(b.id);
    if (h && same(h.at, snapNow())) {
      undoStack.push(...h.undo);
      redoStack.push(...h.redo);
      syncLog = h.sync;
    }
    trimLru(histories, new Set(crumbs), RECENT_HISTORIES);
    stacks();
  }

  return {
    snap,
    mutate,
    live,
    liveCam,
    sync,
    undo,
    redo,
    setBoard,
    beginGesture,
    createFresh,
    settleFresh,
    isFresh: (id: string) => fresh.has(id),
    /** Read and clear the undo / redo flag (see `undone`) */
    takeUndone() {
      const u = undone;
      undone = false;
      return u;
    },
  };
}
