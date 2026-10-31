// Gestures in progress (pointer drags, a held arrow-key nudge). When the host switches boards halfway (into a sub-board, another
// board opened), each one is dropped: listeners removed, nothing committed, so the old board's snapshot never lands in the new
// board's undo stack. View state of the drag (guides, drop target, dragged arrow…) is boardSignal and resets itself; `drop`
// cleans up the rest (timers, the undo snapshot, paused completions)
import { beginGesture, isFresh } from "./state/changes";
import { onBoardSwitch } from "./state/root";
import { holdPointer } from "./ui/guard";
import { holdGhosts } from "@yhnocoder/markdown/ui";

const open = new Set<() => void>();
onBoardSwitch(() => {
  const all = [...open];
  open.clear();
  for (const drop of all) drop();
});

/** A gesture that is not a pointer drag: `drop` runs if the board switches before the returned `done` is called */
export function holdGesture(drop: () => void): () => void {
  open.add(drop);
  return () => {
    open.delete(drop);
  };
}

/** How far (screen px) a press moves before it is a drag, not a click */
export const DRAG_SLOP = 3;
/** A call in code is clicked (expand) far more often than dragged (to a card): it needs a longer move */
export const CALL_DRAG_SLOP = 6;

/**
 * A pointer drag: `move` from the first move past `threshold` screen pixels on, `up` once on release or cancel (moved = it got
 * past the threshold). Pointer capture is taken on the target, so the drag keeps going outside the window
 */
export function track(
  e: PointerEvent,
  move: (ev: PointerEvent) => void,
  up: (ev: PointerEvent, moved: boolean) => void,
  threshold = DRAG_SLOP,
  drop?: () => void,
) {
  const sx = e.clientX,
    sy = e.clientY;
  let moved = false;
  holdPointer(e);
  const ctl = new AbortController();
  const done = holdGesture(() => {
    ctl.abort();
    drop?.();
  });
  const o = { capture: true, signal: ctl.signal };
  const onMove = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return;
    moved = true;
    move(ev);
  };
  const onUp = (ev: PointerEvent) => {
    ctl.abort();
    done();
    up(ev, moved);
  };
  window.addEventListener("pointermove", onMove, o);
  window.addEventListener("pointerup", onUp, o);
  window.addEventListener("pointercancel", onUp, o);
}

/**
 * One undo step for a drag (beginGesture). Once it really moves, AI ghost completions pause (the shown one is cleared, no new
 * asks) until it ends. A drag of cards that are all fresh (createFresh, nothing written yet) is not its own undo step: when
 * content is written, the "new + content" step already has the moved position; ended empty, the card is gone with no step
 */
export function undoGesture(ids: string[] = []) {
  const done = beginGesture();
  const fresh = ids.length > 0 && ids.every(isFresh);
  let held = false;
  return {
    moving: () => {
      if (!held) {
        held = true;
        holdGhosts(true);
      }
    },
    end: () => {
      if (held) holdGhosts(false);
      done(!(fresh && ids.every(isFresh)));
    },
    /** dropped (the board switched): no undo step */
    drop: () => {
      if (held) holdGhosts(false);
      done(false);
    },
  };
}
