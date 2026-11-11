// Zoomed-out summaries (#130; the rules are in core's summary.ts): the board's summary layout, its minimum zoom, and the switch
// between the two levels.
// A zoom gesture does not cross the cut: it stops there (the detent, SUMMARY.detent; detentZoom, interact.ts canvasWheel) and
// has to push through. While pushed, a mist in the board's own colour rises from the bottom edge, a vermilion line along the
// bottom fills, and a seal stamps in near the end (Canvas.tsx reads `detent`); let go, the push drains and they go back. Pushed
// through, the switch runs: the mist covers the whole board (coverMs), the levels swap under it in one frame (the summary level
// built then, if the idle build has not finished: no fade of two live layers), the camera is set across the cut, and the mist
// clears (clearMs). Programmatic zooms (Fit, keys, a summary's double-click) cross freely and get the same covered switch. A
// switch always runs to its end; a push that lands during it is kept for after it, and the zoom crossing back meanwhile is
// followed at once. Opening or switching a board shows its level at once; with reduced motion the switch is instant.
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
import { animate, cam, camMoving, keepCamMoving, setCam, setZoomFloor, viewTracked } from "./camera";
import { boardRef, boardSignal, rooted } from "./root";
import { dragging } from "./ui";
import { zlog, zlogging } from "./zoomlog";
import { CARDS_WAKE_IDLE, SUMMARY_BUILD_IDLE } from "./timing";
import { still } from "./still";

/** What the summary layer measured at the columns' widths (Summaries.tsx), by item */
const [measured, setMeasured] = boardSignal<SumMeasured>(new Map());
export { setMeasured as setSummaryHeights };

const placedRects = () => {
  const m = new Map<string, Rect>();
  for (const c of placed()) m.set(c.id, rectOf(c));
  return m;
};
/** The level shown: 0 = cards, 1 = summaries (they swap in one frame, under the mist) */
const [level, setLevel] = boardSignal<0 | 1>(0);
export const summaryLevel = level;

/** Zoomed in this far past the highest cut nothing shows the summary level and the zoom cannot cross any cut */
const NEAR = 1.5;
/** Zoomed in this much further the built layer is let go (between the two it stays as it is: a zoom back and forth near the
 *  edge does not build it again and again) */
const FAR = NEAR * 1.25;
/** The zoom is near enough to the cut that the summary level may be soon */
const inRange = rooted(() => createMemo(() => cam.z < SUMMARY.cutMax * NEAR));
const outOfRange = rooted(() => createMemo(() => cam.z >= SUMMARY.cutMax * FAR));
/** The summary layer is built: in the first idle time after the zoom came near (building it in the wheel event that crossed
 *  there made that frame 35–55 ms of script, mid-gesture), at once when the switch needs it */
const [built, setBuilt] = boardSignal(false);
/** The summary level is shown, or built because the zoom came near the cut */
const near = rooted(() => createMemo(() => level() === 1 || built()));
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

/** The summary level is shown as the zoom wants it, no switch running, and at the summary level every column measured */
export function summarySettled(): boolean {
  if (running.v || shown.v !== want()) return false;
  if (level() === 0) return true;
  const m = measured();
  return (summaryLayout()?.cols ?? []).every((c) => m.has(c.key));
}

/** The board's content: its cards and its Sections with their title strips */
function contentBounds(): Rect | null {
  const rs: Rect[] = [...placedRects().values()];
  for (const f of frames().values()) rs.push({ x: f.x, y: f.y - SUMMARY.strip, w: f.w, h: f.h + SUMMARY.strip });
  return bounds(rs);
}

/** The level shown (null: none yet on this board) and the switch running (its token; a board switch drops it) */
const shown = boardRef<0 | 1 | null>(null);
const running = boardRef<object | null>(null);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** The board's cut: the zoom below which the summary level shows (0 before the board is laid out) */
export const summaryCut = () => draft()?.cut ?? 0;
/** Every board switches at its cut, one with nothing to summarize too (frames and Free Text stay, Marks and the rest fade) */
const want = rooted(() => createMemo(() => (state.loaded && cam.z < (draft()?.cut ?? 0) ? 1 : 0)));

/** Below the cut the card level stays in the tree. Once the camera rests it is kept drawn (awake): painted at an opacity too
 *  low to show, on a layer of its own, and cull.ts prepares the cards in view under it, so the switch back to the cards opens
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
/** The level a running switch is about to show, drawn under the mist before it is (see run): the summary level with every
 *  column built, the card level awake with the cards in view prepared. null: none */
const [readying, setReadying] = boardSignal<0 | 1 | null>(null);
/** The summary level is about to show: every column is built now (Summaries.tsx) */
export const summaryReadying = () => readying() === 1;
/** The card level is swapped out (styles.css .cardlay.gone: not hit) */
export const cardsGone = rooted(() => createMemo(() => level() === 1));
/** The card level is swapped out and asleep (Canvas.tsx .cardlay.asleep): cull.ts leaves its cards as they are */
export const cardsAsleep = rooted(() =>
  createMemo(() => level() === 1 && readying() !== 0 && (!awake() || camMoving())),
);
/** The card level's opacity: swapped out, 0 asleep and too low to show while it is kept drawn */
export const cardsOpacity = () => (level() === 0 ? 1 : cardsAsleep() ? 0 : 0.003);

/** What Canvas.tsx draws for the detent and the switch: the mist's height (of the viewport; D.cover covers the board whole),
 *  the vermilion line's fill, whether the seal shows and which level it announces */
export type Detent = { mist: number; line: number; seal: boolean; to: 0 | 1 };
const REST: Detent = { mist: 0, line: 0, seal: false, to: 1 };
const [detent, setDetent] = boardSignal<Detent>(REST);
export { detent };
/** The push into the detent (0…1: through) and when it was last pushed */
const push = boardRef(0);
const pushedAt = boardRef(0);
const draining = boardRef(false);
const D = SUMMARY.detent;

const pushed = (q: number, to: 0 | 1) => setDetent({ mist: q * D.mist, line: q, seal: q >= D.seal, to });

/**
 * A zoom gesture's step from z0 to z (around the viewport point p; interact.ts canvasWheel): the zoom it gets. A step towards
 * the cut from the level shown stops at the cut and pushes into the detent by how far it would have gone past; through it,
 * the switch runs (and sets the camera across). A step away from the cut lets the push go. While the switch runs, steps
 * towards the cut are held at it and count for nothing: the switch finishes first, and the zoom goes on from the other side.
 */
export function detentZoom(z0: number, z: number, p: { x: number; y: number }): number {
  const cut = draft()?.cut ?? 0;
  const lv = shown.v;
  if (!cut || lv === null || !state.loaded) return z;
  const towardCut = lv === 0 ? z < z0 && z <= cut : z > z0 && z >= cut;
  if (!towardCut) {
    if (push.v && !running.v) {
      push.v = 0;
      setDetent(REST);
    }
    return z;
  }
  if (running.v) return z0 === cut || (lv === 0 ? z0 < cut : z0 > cut) ? z0 : cut;
  const to: 0 | 1 = lv === 0 ? 1 : 0;
  // held at the cut, the camera does not change: the gesture still goes on (no stop, no re-raster of the world under the mist)
  keepCamMoving();
  push.v = Math.min(1, push.v + Math.min(1, Math.abs(Math.log(z / z0)) / D.notch));
  pushedAt.v = performance.now();
  if (push.v >= 1) run(to, p);
  else {
    pushed(push.v, to);
    drain();
  }
  return cut;
}
/** Let go before it is through, the push drains: the mist sinks, the line empties, the seal goes */
function drain() {
  if (draining.v) return;
  draining.v = true;
  const to = untrack(detent).to;
  animate((dt, instant) => {
    if (!draining.v) return true;
    if (running.v || push.v <= 0) {
      draining.v = false;
      return true;
    }
    if (instant || performance.now() - pushedAt.v > D.drainAfter) {
      push.v = instant ? 0 : Math.max(0, push.v - dt * D.drain);
      if (push.v <= 0) setDetent(REST);
      else pushed(push.v, to);
    }
    if (push.v > 0) return false;
    draining.v = false;
    return true;
  });
}

/** The board was opened or switched to and its camera set: show its level at once */
export function showSummaryLevel() {
  running.v = null;
  setReadying(null);
  draining.v = false;
  push.v = 0;
  setDetent(REST);
  shown.v = want();
  setLevel(shown.v);
  setAwake0(false);
}

/** Frames the level to show is drawn under the mist before it shows: a level made visible in the frame it is first drawn
 *  in (the card level woken from asleep, the summary columns built at the swap) has its tiles rastered for the frame that shows
 *  it, and on a GPU short of tile memory the mist cleared over a blank board. Drawn a frame before, its tiles are there:
 *  Chromium does not commit a frame while the one before it waits for its tiles */
const READY_FRAMES = 1;

/**
 * The switch to a level: the mist covers the board (from where the push left it); under it the level to show is drawn (the
 * summary level built whole, or the card level woken with the cards in view shown) and READY_FRAMES later the levels swap in
 * one frame (from a push, the camera is set just across the cut around the push, so the zoom goes on from the other side);
 * then the mist clears. Crossed back meanwhile (a programmatic zoom), the switch back follows at once.
 */
function run(to: 0 | 1, at?: { x: number; y: number }) {
  const me = {};
  running.v = me;
  draining.v = false;
  push.v = 0;
  const from = shown.v ?? 0;
  const mist0 = untrack(detent).mist;
  if (zlogging()) zlog("S", `${from}→${to} start z${cam.z.toFixed(4)}`);
  let t = 0,
    covered = false,
    ready = -1;
  const swap = () => {
    covered = true;
    shown.v = to;
    setLevel(to);
    if (at) {
      const z = to === 1 ? (draft()?.cut ?? cam.z) * 0.9 : (draft()?.cut ?? cam.z) * 1.1;
      setCam(at.x - ((at.x - cam.x) * z) / cam.z, at.y - ((at.y - cam.y) * z) / cam.z, z);
    }
    // the zoom log: the script of the swap's frame (the frame's updates run together after this, camera.ts tick), where
    // the summary columns not built yet are built
    if (zlogging()) {
      const t0 = performance.now();
      queueMicrotask(() => zlog("S", `${to} swap frame ${(performance.now() - t0).toFixed(1)}`));
    }
  };
  animate((dt, instant) => {
    if (running.v !== me) return true;
    const total = D.coverMs + D.clearMs;
    t = instant ? 1 : Math.min(1, t + (dt * 1000) / total);
    const cover = D.coverMs / total;
    if (t >= cover && !covered) {
      // covered: the level to show is drawn under the mist first (not built yet, pushed through before an idle moment: it is
      // built now), and shown READY_FRAMES frames later
      if (ready < 0) {
        ready = 0;
        if (to === 1 && !untrack(built)) setBuilt(true);
        setReadying(to);
      }
      if (ready++ < READY_FRAMES) {
        t = cover;
        if (!instant) setDetent({ mist: D.cover, line: 1, seal: true, to });
        return false;
      }
    }
    if (t < cover) setDetent({ mist: mist0 + (D.cover - mist0) * easeOut(t / cover), line: 1, seal: true, to });
    else {
      if (!covered) {
        swap();
        setReadying(null);
      }
      const k = (t - cover) / (1 - cover);
      setDetent({ mist: D.cover * (1 - easeInOut(k)), line: 1 - k, seal: k < 0.15, to });
    }
    if (t < 1) return false;
    setDetent(REST);
    running.v = null;
    // swapped out under a camera at rest: its tiles are there, keep them
    if (to === 1) setAwake(!untrack(camMoving));
    if (zlogging()) zlog("S", `${to} end`);
    // the zoom crossed back during the switch: the switch back follows at once
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
      // a still picture's summaries are part of what it covers (still.ts): built at once, at any zoom
      if (still()) {
        if (!built()) setBuilt(true);
        return;
      }
      if (inRange() && !built()) {
        if (idle !== undefined) return;
        const go = () => {
          idle = undefined;
          if (untrack(inRange) && !untrack(built)) setBuilt(true);
        };
        idle = requestIdleCallback(go, { timeout: SUMMARY_BUILD_IDLE });
      } else if (outOfRange() && built() && level() === 0) setBuilt(false);
    });
    let wake: number | undefined;
    createEffect(() => {
      if (level() < 1 || awake() || camMoving() || wake !== undefined) return;
      // woken in an idle moment: the repaint of every card then lands in no frame of a gesture
      wake = requestIdleCallback(
        () => {
          wake = undefined;
          if (untrack(level) === 1 && !untrack(awake) && !untrack(camMoving)) setAwake(true);
        },
        { timeout: CARDS_WAKE_IDLE },
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
