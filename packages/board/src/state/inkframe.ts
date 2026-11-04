// Ink Wash's Section frame (#137, the approved mock's option D, feedback/demo/inkwash-section.html paintD): four strokes of a
// dry brush instead of a border. Each stroke starts pressed and round, bows a little, swells and thins along its length and lifts
// into a thin round tail; the corners overshoot and cross. Some strokes break, never with a clean cut: mostly a dry passage
// (飞白: the stroke narrows, splits into a few hairline strands with paper between them and recovers), rarely a lift (a tapered tail
// and the next stroke's pressed head laid over it). A few strokes split into two along part of their tail (a dry streak). The top
// stroke leaves a gap where the title is written (themes.css .slabel).
// One filled path per frame, no filters and no masks: the colour is the SVG's currentColor, so selecting a Section only
// changes a CSS colour. Drawn once per size, title width and Section and cached; the texture is keyed by stroke and distance
// along it (not by a running random sequence), so resizing a Section by drag grows the strokes without the rest of the frame
// changing.
import { fnv } from "@codeboard/core/canvas";
import { state } from "./store";
import { boardStore } from "./root";
import { rng } from "./ink";

/** How far the frame's image reaches outside the Section on each side (overshooting corners, bowing strokes) */
const FRAME_M = 12;
/** The brush's width */
const BRUSH = 2.5;
/** Samples along a stroke, px */
const STEP = 4;
/** Sizes are rounded to this before drawing (the drawing is not stretched: the image is up to 1 px off the frame) */
const SIZE_STEP = 2;
/** The top stroke's gap: it stops this far right of the frame's left edge and starts again this far right of the title */
const GAP_IN = 8;
const GAP_OUT = 20;

const f = (n: number) => String(Math.round(n * 10) / 10);
/** Noise in [0, 1) for sample i of stroke k: the same at the same distance along the stroke, whatever its length */
function hash(k: number, i: number) {
  let t = Math.imul(k ^ Math.imul(i + 1, 0x9e3779b1), 0x85ebca6b);
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35);
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

type U = (i: number) => number;

/**
 * One brush stroke from a to b into out (closed subpaths, all wound the same way so overlaps stay filled). key picks its
 * texture and its breaks; breaks: whether it may break or split (the short stub left of the title does not)
 */
function stroke(
  out: string[],
  key: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  w: number,
  breaks: boolean,
) {
  const L = Math.hypot(bx - ax, by - ay);
  if (L < 1) return;
  const ux = (bx - ax) / L,
    uy = (by - ay) / L,
    nx = -uy,
    ny = ux,
    n = Math.max(4, Math.ceil(L / STEP));
  // every choice drawn up front in the same order, so a longer stroke makes the same ones
  const r = rng(key),
    ph = r() * 6,
    bow = (r() - 0.5) * 1.4,
    wantBreak = r() < 0.75,
    lift = r() < 0.18,
    at = 0.3 + r() * 0.4,
    dryLen = 28 + r() * 16,
    wantSplit = r() < 0.6,
    splitAt = 0.5 + r() * 0.15,
    splitLen = 25 + r() * 30,
    splitO = (r() - 0.5) * 0.4,
    pointA = (r() - 0.5) * 0.3,
    pointB = (r() - 0.5) * 0.3,
    strands = Array.from({ length: 5 }, () => [r(), r(), r(), r(), r()]),
    nStrands = 3 + Math.floor(r() * 2.99);
  const idx = (d: number) => Math.max(0, Math.min(n, Math.round((d / L) * n)));
  // the break: a dry passage [b0, b1] or a lift at b0
  const brk = breaks && wantBreak && L > 140;
  const b0 = idx(at * L - (lift ? 0 : dryLen / 2)),
    b1 = lift ? b0 : idx(at * L + dryLen / 2);
  const dip0 = (b0 - 3) * (L / n),
    dip1 = (b1 + 3) * (L / n);
  const pl = Math.min(0.1 * L, 16),
    tl = Math.min(0.22 * L, 56);
  const cx = new Float64Array(n + 1),
    cy = new Float64Array(n + 1),
    ww = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      d = t * L;
    const press = d < pl ? 1 + 0.55 * (1 - d / pl) : 1;
    const taper = d > L - tl ? Math.max(0.3, 1 - ((d - (L - tl)) / tl) * 0.7) : 1;
    // the stroke narrows into a dry passage and recovers after it
    const dip = brk && !lift && d > dip0 && d < dip1 ? 1 - 0.2 * Math.sin((Math.PI * (d - dip0)) / (dip1 - dip0)) : 1;
    ww[i] = w * (0.8 + 0.2 * Math.sin(d / 55 + ph) + (hash(key, i) - 0.5) * 0.2) * press * taper * dip;
    const off = bow * Math.sin(Math.PI * t) + (hash(key + 7, i) - 0.5) * 0.3;
    cx[i] = ax + ux * d + nx * off;
    cy[i] = ay + uy * d + ny * off;
  }
  const pt = (i: number, u: number) => `${f(cx[i] + nx * ww[i] * u)} ${f(cy[i] + ny * ww[i] * u)}`;
  /** a round end: a half circle from one side of the band to the other, around its end (dir 1) or its start (dir −1) */
  const cap = (i: number, lo: number, hi: number, dir: 1 | -1) => {
    const m = (lo + hi) / 2,
      rad = (ww[i] * (hi - lo)) / 2;
    let s = "";
    for (const a of [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
      const c = Math.cos(a) * dir,
        sn = Math.sin(a) * dir;
      s += `L${f(cx[i] + nx * (ww[i] * m + rad * c) + ux * rad * sn)} ${f(cy[i] + ny * (ww[i] * m + rad * c) + uy * rad * sn)}`;
    }
    return s;
  };
  /** the band between lo(i) and hi(i) (in brush widths across the stroke, −0.5 … 0.5) from sample i0 to i1 */
  const piece = (i0: number, i1: number, lo: U, hi: U, capStart: boolean, capEnd: boolean) => {
    if (i1 <= i0) return;
    const top: string[] = [],
      bot: string[] = [];
    for (let i = i0; i <= i1; i++) {
      top.push(pt(i, hi(i)));
      bot.push(pt(i, lo(i)));
    }
    let d = `M${top.join("L")}`;
    // the end cap goes from the hi side round to the lo side, the start cap from lo back to hi
    if (capEnd) d += cap(i1, lo(i1), hi(i1), 1);
    d += `L${bot.reverse().join("L")}`;
    if (capStart) d += cap(i0, lo(i0), hi(i0), -1);
    out.push(`${d}Z`);
  };
  /** a solid run of the stroke; a dry streak [s0, s1] inside it splits it in two along a hairline that opens and closes */
  const run = (i0: number, i1: number, lo: U, hi: U, capStart: boolean, capEnd: boolean, split?: [number, number]) => {
    if (!split) return piece(i0, i1, lo, hi, capStart, capEnd);
    const [s0, s1] = split,
      gap = (i: number) => (i <= s0 || i >= s1 ? 0 : 0.24 * Math.sin((Math.PI * (i - s0)) / (s1 - s0)));
    piece(i0, s0, lo, hi, capStart, false);
    piece(s0 - 1, s1 + 1, (i) => Math.min(hi(i), splitO + gap(i) / 2), hi, false, false);
    piece(s0 - 1, s1 + 1, lo, (i) => Math.max(lo(i), splitO - gap(i) / 2), false, false);
    piece(s1, i1, lo, hi, false, capEnd);
  };
  const LO: U = () => -0.5,
    HI: U = () => 0.5;
  // the dry streak, in the stroke's later half, clear of the break and of the tail
  const sp0 = idx(splitAt * L),
    sp1 = idx(splitAt * L + splitLen);
  const splitOk = breaks && wantSplit && L > 90 && sp1 < idx(L - tl * 0.6) && sp1 - sp0 >= 4;
  const clear = (a: number, b: number) =>
    splitOk && sp0 > a + 2 && sp1 < b - 2 ? ([sp0, sp1] as [number, number]) : undefined;
  if (!brk) return run(0, n, LO, HI, true, true, clear(0, n));
  if (lift) {
    // the brush lifts: a tail thinning to a quarter, then a new pressed head laid over it, a hair off the line
    const shrink = (i: number) => 1 - 0.75 * smooth((i - (b0 - 4)) / 5),
      press = (i: number) => 1 + 0.35 * (1 - smooth((i - (b0 - 1)) / 3)),
      dv = (hash(key, 999) - 0.5) * 0.5;
    piece(
      0,
      b0 + 1,
      (i) => -0.5 * shrink(i),
      (i) => 0.5 * shrink(i),
      true,
      true,
    );
    return run(
      b0 - 1,
      n,
      (i) => -0.5 * press(i) + dv,
      (i) => 0.5 * press(i) + dv,
      true,
      true,
      clear(b0 + 3, n),
    );
  }
  // a dry passage: the solid stroke runs to a point a little into it, a few strands carry on across it, and the stroke grows back
  // from a point before it ends
  const reach = Math.max(1, Math.round(0.45 * (b1 - b0))),
    aEnd = b0 + reach,
    bStart = b1 - reach;
  const into = (i: number) => smooth((i - (b0 - 2)) / (aEnd - (b0 - 2))),
    outOf = (i: number) => 1 - smooth((i - bStart) / (b1 + 2 - bStart));
  piece(
    0,
    aEnd,
    (i) => -0.5 + into(i) * (0.5 + pointA),
    (i) => 0.5 - into(i) * (0.5 - pointA),
    true,
    false,
  );
  for (let k = 0; k < nStrands; k++) {
    // in px: the hairs splay a little wider than the stroke, each thin enough for paper to show between them at 100%
    const [q0, q1, q2, q3, q4] = strands[k],
      u = w * (-0.8 + (1.6 * (k + 0.5 + (q0 - 0.5) * 0.4)) / nStrands),
      hw = 0.2 + q1 * 0.16,
      // the outer strands cross the whole passage; inner ones may start late or stop early (a hair of the brush ran dry)
      outer = k === 0 || k === nStrands - 1,
      s0 = b0 - 2 + (outer ? 0 : Math.floor(q2 * 0.35 * (b1 - b0))),
      s1 = b1 + 2 - (outer ? 0 : Math.floor(q3 * 0.35 * (b1 - b0)));
    const q = (i: number) => Math.max(0, Math.min(1, (i - s0) / 2, (s1 - i) / 2)),
      // the hairs fan out of the solid stroke and gather back into it
      c = (i: number) =>
        u * (0.4 + 0.6 * Math.sin((Math.PI * (i - s0)) / (s1 - s0))) + 0.12 * Math.sin(i * 0.9 + q4 * 6);
    piece(
      s0,
      s1,
      (i) => (c(i) - hw * q(i)) / ww[i],
      (i) => (c(i) + hw * q(i)) / ww[i],
      false,
      false,
    );
  }
  run(
    bStart,
    n,
    (i) => -0.5 + outOf(i) * (0.5 + pointB),
    (i) => 0.5 - outOf(i) * (0.5 - pointB),
    false,
    true,
    clear(b1 + 3, n),
  );
}

/** The frame's path for a w × h Section (the image is FRAME_M bigger on each side); gap: the title's width, 0 = no gap */
function framePath(w: number, h: number, seed: number, gap: number) {
  const m = FRAME_M,
    x0 = m,
    y0 = m,
    x1 = w + m,
    y1 = h + m,
    k = seed * 8,
    out: string[] = [];
  if (gap > 0) {
    const ga = x0 + GAP_IN,
      gb = Math.min(x1 - 30, ga + gap + GAP_OUT);
    stroke(out, k, x0 - 4, y0 + 0.5, ga, y0 - 0.3, BRUSH * 0.9, false);
    if (x1 + 5 - gb > 12) stroke(out, k + 1, gb, y0 - 0.5, x1 + 5, y0 + 0.6, BRUSH, true);
  } else stroke(out, k + 1, x0 - 4, y0 + 0.5, x1 + 5, y0 + 0.6, BRUSH, true);
  stroke(out, k + 2, x1 + 0.3, y0 - 5, x1 - 0.5, y1 + 4, BRUSH * 1.05, true);
  stroke(out, k + 3, x0 - 0.5, y0 - 3, x0 + 0.6, y1 + 6, BRUSH * 1.1, true);
  stroke(out, k + 4, x0 - 5, y1 + 0.4, x1 + 6, y1 - 0.6, BRUSH, true);
  return out.join("");
}

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
