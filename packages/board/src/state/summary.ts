// Zoomed-out summaries (#130; the rules are in core's summary.ts): the board's summary layout, its minimum zoom, and the switch
// between the two levels. The switch is a timed cross-fade of whole layers (SUMMARY.fadeMs, ease-in-out): it starts when the zoom
// crosses the board's cut, always runs to its end, and when the zoom has crossed back meanwhile the reverse fade follows at once.
// Opening or switching a board shows its level at once; with reduced motion the switch is instant.
import { createEffect, createMemo, on, untrack } from "solid-js";
import {
  SUMMARY,
  bounds,
  layoutSummaries,
  summaryMinZoom,
  summarySources,
  type Rect,
  type SumLayout,
  type SumMeasured,
} from "@codeboard/core";
import { state, placed, rectOf } from "./store";
import { frames } from "./sections";
import { animate, cam, camMoving, setZoomFloor, viewTracked } from "./camera";
import { boardRef, boardSignal, rooted } from "./root";
import { dragging } from "./ui";
import { zlog, zlogging } from "./zoomlog";

/** What the summary layer measured at the columns' widths (Summaries.tsx), by item */
const [measured, setMeasured] = boardSignal<SumMeasured>(new Map());
export { setMeasured as setSummaryHeights };

const placedRects = () => {
  const m = new Map<string, Rect>();
  for (const c of placed()) m.set(c.id, rectOf(c));
  return m;
};
/** 0 = cards, 1 = summaries, in between while fading */
const [fade, setFade] = boardSignal(0);
export const summaryFade = fade;

/** Zoomed in this far past the highest cut nothing shows the summary level and the zoom cannot cross any cut */
const NEAR = 1.5;
/** Zoomed in this much further the built layer is let go (between the two it stays as it is: a zoom back and forth near the
 *  edge does not build it again and again) */
const FAR = NEAR * 1.25;
/** The zoom is near enough to the cut that the summary level may be soon */
const inRange = rooted(() => createMemo(() => cam.z < SUMMARY.cutMax * NEAR));
const outOfRange = rooted(() => createMemo(() => cam.z >= SUMMARY.cutMax * FAR));
/** The summary layer is built: in the first idle time after the zoom came near (building it in the wheel event that crossed
 *  there made that frame 35–55 ms of script, mid-gesture), at once when the fade needs it */
const [built, setBuilt] = boardSignal(false);
/** The summary level is shown, fading, or built because the zoom came near the cut */
const shownOrFading = rooted(() => createMemo(() => fade() > 0));
const near = rooted(() => createMemo(() => shownOrFading() || built()));
/** The summary layer exists only then (Summaries.tsx): zoomed in it costs nothing, and it is built before the zoom reaches a cut */
export const summaryNear = near;
/** A layout is held while cards are dragged, and while the summary level is far away (nudges, undo and edits zoomed in then
 *  cost no layout: it catches up once the zoom comes near); a board switch always lays out again */
const held = (prev: SumLayout | undefined, board: { v: string }) => {
  const id = state.board.id;
  if (prev && board.v === id && (dragging().size || !near())) return true;
  board.v = id;
  return false;
};

/** The layout before measuring: the widths, the font size and the cut */
const draftBoard = boardRef("");
const draft = rooted(() =>
  createMemo<SumLayout | undefined>((prev) => {
    if (held(prev, draftBoard)) return prev;
    const rs = placedRects();
    return layoutSummaries(summarySources(state.board, (id) => rs.get(id), frames()));
  }),
);
/** The summary level's layout, with the heights the page measured */
const layoutBoard = boardRef("");
export const summaryLayout = rooted(() =>
  createMemo<SumLayout | undefined>((prev) => {
    if (held(prev, layoutBoard)) return prev;
    const rs = placedRects();
    const m = measured();
    return m.size
      ? layoutSummaries(
          summarySources(state.board, (id) => rs.get(id), frames()),
          m,
        )
      : draft();
  }),
);

/** The board's content: its cards and its Sections with their title strips */
function contentBounds(): Rect | null {
  const rs: Rect[] = [...placedRects().values()];
  for (const f of frames().values()) rs.push({ x: f.x, y: f.y - SUMMARY.strip, w: f.w, h: f.h + SUMMARY.strip });
  return bounds(rs);
}

/** The level shown (null: none yet on this board) and the fade running (its token; a board switch drops it) */
const shown = boardRef<0 | 1 | null>(null);
const running = boardRef<object | null>(null);
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** Every board switches at its cut, one with nothing to summarize too (frames and Free Text stay, Marks and the rest fade) */
const want = rooted(() => createMemo(() => (state.loaded && cam.z < (draft()?.cut ?? 0) ? 1 : 0)));

/** The level the fade runs to */
const [toward, setToward] = boardSignal<0 | 1>(0);
/** Below the cut the card level stays in the tree. Once the camera rests it is kept drawn (awake): painted at an opacity too
 *  low to show, on a layer of its own, and cull.ts prepares the cards in view under it, so the fade back to the cards opens
 *  on whole cards, from tiles already there. While the camera moves it is asleep (styles.css .cardlay.asleep: clipped to
 *  nothing, so none of its cards is painted; a zoom or pan at the summary level draws the summaries only, where a level
 *  painted under them was painted again on every frame, 15–40 ms a frame on 241 cards). Waking is a repaint of the cards,
 *  taken in an idle moment at rest; hiding the level instead (content-visibility) made the frame that showed it again style
 *  and lay out every card at once, 400 ms on a board of 41 cards */
const [awake, setAwake0] = boardSignal(false);
function setAwake(on: boolean) {
  setAwake0(on);
  if (zlogging()) zlog("W", `card level ${on ? "kept drawn" : "let go"} z${cam.z.toFixed(4)}`);
}
/** The card level is faded out (styles.css .cardlay.gone: not hit) */
export const cardsGone = rooted(() => createMemo(() => fade() === 1));
/** The card level is fading out: cull.ts shows no card entering the view then (a card never seen is not painted just to
 *  fade; its box is hidden instead) */
export const cardsLeaving = rooted(() => createMemo(() => fade() > 0 && fade() < 1 && toward() === 1));
/** The card level is faded out and asleep (Canvas.tsx .cardlay.asleep): cull.ts leaves its cards as they are */
export const cardsAsleep = rooted(() => createMemo(() => fade() === 1 && (!awake() || camMoving())));
/** The card level's opacity: faded out, 0 asleep and too low to show while it is kept drawn */
export const cardsOpacity = () => (fade() < 1 ? 1 - fade() : cardsAsleep() ? 0 : 0.003);

/** The board was opened or switched to and its camera set: show its level at once, without a fade */
export function showSummaryLevel() {
  running.v = null;
  shown.v = want();
  setToward(shown.v);
  setFade(shown.v);
  setAwake0(false);
}

function run(to: 0 | 1) {
  const me = {};
  running.v = me;
  const from = shown.v ?? 0;
  setToward(to);
  if (zlogging()) zlog("S", `${from}→${to} start z${cam.z.toFixed(4)}`);
  let t = 0;
  animate((dt, instant) => {
    if (running.v !== me) return true;
    // not built yet (the zoom crossed the cut before an idle moment): it is built now, in the fade's first frame
    if (to === 1 && !untrack(built)) setBuilt(true);
    const first = t === 0;
    t = instant ? 1 : Math.min(1, t + (dt * 1000) / SUMMARY.fadeMs);
    setFade(from + (to - from) * ease(t));
    // the zoom log: the script of the fade's first frame (the frame's updates run together after this, camera.ts tick), where
    // the summary columns not built yet are built
    if (first && t > 0 && zlogging()) {
      const t0 = performance.now();
      queueMicrotask(() => zlog("S", `${to} first frame ${(performance.now() - t0).toFixed(1)}`));
    }
    if (t < 1) return false;
    shown.v = to;
    running.v = null;
    // faded out under a camera at rest: its tiles are there, keep them
    if (to === 1) setAwake(!untrack(camMoving));
    if (zlogging()) zlog("S", `${to} end`);
    // the zoom crossed back during the fade: the reverse one follows at once
    const w = untrack(want);
    if (w !== to) run(w);
    return true;
  });
}

/** Wires the minimum zoom and the level switch to the board (wire.ts) */
export function wireSummaries() {
  rooted(() => {
    createEffect(() => setZoomFloor(summaryMinZoom(viewTracked(), contentBounds())));
    let idle: number | undefined;
    createEffect(() => {
      if (inRange() && !built()) {
        if (idle !== undefined) return;
        const go = () => {
          idle = undefined;
          if (untrack(inRange) && !untrack(built)) setBuilt(true);
        };
        idle = requestIdleCallback(go, { timeout: 400 });
      } else if (outOfRange() && built() && !shownOrFading()) setBuilt(false);
    });
    let wake: number | undefined;
    createEffect(() => {
      if (fade() < 1 || awake() || camMoving() || wake !== undefined) return;
      // woken in an idle moment: the repaint of every card then lands in no frame of a gesture
      wake = requestIdleCallback(
        () => {
          wake = undefined;
          if (untrack(fade) === 1 && !untrack(awake) && !untrack(camMoving)) setAwake(true);
        },
        { timeout: 500 },
      );
    });
    createEffect(
      on(want, (w) => {
        if (shown.v === null) showSummaryLevel();
        else if (!running.v && w !== shown.v) run(w);
      }),
    );
  });
}
