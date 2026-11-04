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
import { animate, cam, setZoomFloor, viewTracked } from "./camera";
import { boardRef, boardSignal, rooted } from "./root";
import { dragging } from "./ui";

/** What the summary layer measured at the columns' widths (Summaries.tsx), by item */
const [measured, setMeasured] = boardSignal<SumMeasured>(new Map());
export { setMeasured as setSummaryHeights };

const placedRects = () => {
  const m = new Map<string, Rect>();
  for (const c of placed()) m.set(c.id, rectOf(c));
  return m;
};
/** The layout before measuring: the widths, the font size and the cut (held while cards are dragged: nothing shows it then) */
const draft = rooted(() =>
  createMemo<SumLayout | undefined>((prev) => {
    if (prev && dragging().size) return prev;
    const rs = placedRects();
    return layoutSummaries(summarySources(state.board, (id) => rs.get(id), frames()));
  }),
);
/** The summary level's layout, with the heights the page measured */
export const summaryLayout = rooted(() =>
  createMemo<SumLayout | undefined>((prev) => {
    if (prev && dragging().size) return prev;
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
/** The board summarizes something: it has a summary level */
const hasSummaries = () => !!draft()?.cols.length;

/** The board's content: its cards and its Sections with their title strips */
function contentBounds(): Rect | null {
  const rs: Rect[] = [...placedRects().values()];
  for (const f of frames().values()) rs.push({ x: f.x, y: f.y - SUMMARY.strip, w: f.w, h: f.h + SUMMARY.strip });
  return bounds(rs);
}

/** 0 = cards, 1 = summaries, in between while fading */
const [fade, setFade] = boardSignal(0);
export const summaryFade = fade;
/** The level shown (null: none yet on this board) and the fade running (its token; a board switch drops it) */
const shown = boardRef<0 | 1 | null>(null);
const running = boardRef<object | null>(null);
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const want = rooted(() => createMemo(() => (state.loaded && hasSummaries() && cam.z < (draft()?.cut ?? 0) ? 1 : 0)));

/** The board was opened or switched to and its camera set: show its level at once, without a fade */
export function showSummaryLevel() {
  running.v = null;
  shown.v = want();
  setFade(shown.v);
}

function run(to: 0 | 1) {
  const me = {};
  running.v = me;
  const from = shown.v ?? 0;
  let t = 0;
  animate((dt, instant) => {
    if (running.v !== me) return true;
    t = instant ? 1 : Math.min(1, t + (dt * 1000) / SUMMARY.fadeMs);
    setFade(from + (to - from) * ease(t));
    if (t < 1) return false;
    shown.v = to;
    running.v = null;
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
    createEffect(
      on(want, (w) => {
        if (shown.v === null) showSummaryLevel();
        else if (!running.v && w !== shown.v) run(w);
      }),
    );
  });
}
