// Every change to the board goes through here: core's undo engine and saving (@codeboard/core/history) wired to the Solid store
import { batch, createSignal } from "solid-js";
import { produce, reconcile, unwrap } from "solid-js/store";
import {
  applyPatch,
  applySharedUpdate,
  putSummary,
  summaryOf,
  summaryPending,
  type Board,
  type BoardPatch,
  type SegView,
  type SharedUpdate,
  type Summary,
} from "@codeboard/core";
import { ask } from "../host";
import { createHistory, createSave, type Doc, type HistoryPorts } from "@codeboard/core/history";
import { dropGone } from "@codeboard/core/commands";
import { noteBlocks } from "../md/blocks";
import { setState, state } from "./store";
import { keepOn, unselectCard } from "./selection";
import { putViews, requestMissing } from "./views";
import { toast } from "./toast";
import { ghostOut } from "./ghost";
import { LIVE_DELAY, RESEND_DELAY } from "./timing";

// a path the store's typed setter can't spell (collection k, index or place key at)
const setAt = setState as unknown as (
  b: "board",
  k: string,
  at: number | string,
  v: ReturnType<typeof reconcile>,
) => void;
const doc: Doc = {
  read: () => unwrap(state.board),
  write: (fn) => setState("board", produce(fn)),
  replace: (b) => setState("board", reconcile(b)),
  putItems: (ops) =>
    batch(() => {
      for (const [k, at, v] of ops) setAt("board", k, at, reconcile(v));
    }),
  raw: unwrap,
};

// the engine reads selfCheck on every edit: on in dev builds and unit tests, and where the shell booting the board asks for it
const ports: HistoryPorts = { noteBlocks, selfCheck: import.meta.env.DEV };
/** Boot: run the engine's self-check (HistoryPorts.selfCheck) after every edit, in a production build too (the harness) */
export const checkEdits = (on: boolean) => {
  ports.selfCheck = on;
};

const [canUndo, setCanUndo] = createSignal(false);
const [canRedo, setCanRedo] = createSignal(false);
export { canUndo, canRedo };

const history = createHistory(
  doc,
  {
    changed: () => save.changed(),
    changedLive: () => save.changedLive(),
    stacks: (u, r) =>
      batch(() => {
        setCanUndo(u);
        setCanRedo(r);
      }),
    restored: () => {
      keepOn(state.board);
      requestMissing(state.board);
    },
    toast,
  },
  ports,
);
const save = createSave({
  loaded: () => state.loaded,
  snap: history.snap,
  cam: () => state.board.cam,
  takeUndone: history.takeUndone,
  post: (patch, undo) => ask("patch", undo ? { patch, undo: true } : { patch }),
  toast,
  liveDelay: LIVE_DELAY,
  resendDelay: RESEND_DELAY,
});

export const { mutate, sync, live, liveCam, undo, redo, setBoard, beginGesture, createFresh, isFresh } = history;
export const { flush: flushSave, markSaved } = save;

/** The first edit of a new card ends: keep = content was written (`fn` writes it); not kept, the card fades out */
export function settleFresh(id: string, keep: boolean, fn?: (b: Board) => void) {
  if (!keep && isFresh(id)) ghostOut([id]);
  history.settleFresh(id, keep, fn);
  if (!keep) unselectCard(id);
}

// The host changed the board itself: what is not sent yet goes out first, then "sent" is aligned to now, so these are not sent back.
// They are syncs: no undo step, replayed after undo
/** Another board changed shared cards (forwarded by the host, or items the host skipped on an undo): swapped in by item */
export function syncShared(cards: SharedUpdate[], views?: Record<string, SegView>) {
  flushSave();
  const keys = cards.flatMap((sc) => sc.items.map((id) => (id === sc.card.id ? `c${id}` : `n${id}`)));
  batch(() => {
    if (views) putViews(views);
    // core applySharedUpdate: replaced by index, other cards not notified; a fresh copy each time (an undo's reconcile changes the
    // board's objects in place, a replay must not get one of those)
    sync((b) => {
      for (const sc of cards) applySharedUpdate(b, sc);
    }, keys);
  });
  save.alignSent();
}
/** Another board's Delete Everywhere removed these shared cards (the host already did) */
export function syncGone(ids: string[]) {
  flushSave();
  sync((b) => dropGone(b, ids));
  save.alignSent();
}
/** Another window changed this board's file and the host merged it in when writing */
export function syncMerged(p: BoardPatch, views?: Record<string, SegView>) {
  flushSave();
  batch(() => {
    if (views) putViews(views);
    sync((b) => applyPatch(b, structuredClone(p)));
  });
  save.alignSent();
}
/** Summaries the host wrote by itself (zoomed out; host summaries.ts): saved like any change, no undo step. One the user edited
 *  after the host asked (its newest edit is not the one the host wrote from), or kept as it is (保留: no longer pending), stays as
 *  the user left it */
export function syncSummaries(items: Record<string, Summary>) {
  sync((b) => {
    for (const [k, s] of Object.entries(items)) {
      const now = summaryOf(b, k);
      if (now?.edited && now.pairs?.[0]?.at !== s.pairs?.[0]?.at) continue;
      if (now && !summaryPending(b, k)) continue;
      putSummary(b, k, structuredClone(s));
    }
  });
}
