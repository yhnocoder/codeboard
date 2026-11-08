// Ink Wash's Section frame (#137): the brush strokes themselves are core's (@codeboard/core/canvas inkframe.ts); this caches a
// frame per Section, rounded size and title width, and keeps the titles' measured widths for the gap in the top stroke.
import { fnv, FRAME_M, framePath } from "@codeboard/core/canvas";
import { state } from "./store";
import { boardStore } from "./root";

/** Sizes are rounded to this before drawing (the drawing is not stretched: the image is up to 1 px off the frame) */
const SIZE_STEP = 2;

const frames = new Map<string, string>();
/** The frame of Section id at w × h, with a gap of the title's width in the top stroke (0 = none, a collapsed Section): the
 *  image's size and its path (cached by rounded size, gap and Section) */
export function brushFrame(w: number, h: number, id: string, gap: number) {
  const W = Math.max(SIZE_STEP, Math.round(w / SIZE_STEP) * SIZE_STEP),
    H = Math.max(SIZE_STEP, Math.round(h / SIZE_STEP) * SIZE_STEP),
    g = Math.round(gap / SIZE_STEP) * SIZE_STEP,
    seed = fnv(id) & 0xffffff,
    k = `${W}x${H}:${g}:${seed}`;
  let d = frames.get(k);
  if (d === undefined) {
    // a long session of resizing would grow it without end: start over past a few hundred
    if (frames.size > 400) frames.clear();
    frames.set(k, (d = framePath(W, H, seed, g)));
  }
  return { w: W + 2 * FRAME_M, h: H + 2 * FRAME_M, d };
}

// The titles' widths (canvas/Sections.tsx measures each title when its size changes: renamed, its font loaded), for the gap.
// Kept across a board switch for the Sections the new board still has (their titles stay mounted and are not measured again)
const [titles, setTitles] = boardStore<Record<string, number | undefined>>(
  () => ({}),
  (id) => state.board.sections.some((s) => s.id === id),
);
export const titleWidth = (id: string) => titles[id] ?? 0;
export function setTitleWidth(id: string, w: number) {
  const v = Math.round(w);
  if (titles[id] !== v) setTitles(id, v);
}
