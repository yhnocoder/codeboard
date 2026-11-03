// Tapered lines (Warm Ink): a route (route.ts's path) drawn as a filled outline instead of a stroked line, heavier at its
// source and thinning evenly towards its head, with a rounded start. Unlike the brush (brush.ts) it has no wobble and no dry
// brush: a clean pen line. A share of it (`upto` < 1) is the line still being drawn from its source, ending in a point and a
// direction for the head that travels with it. Pure computation, no DOM; the board recomputes it only when a link's geometry
// changes (every frame while one of its cards moves).
import { pathWalker } from "./brush";

const f = (n: number) => String(Math.round(n * 100) / 100);

export type Taper = {
  /** The filled outline; empty for a path of fewer than two points */ d: string;
  /** Where the drawn part ends and its direction there (unit): the tip of the head */ end: {
    x: number;
    y: number;
    ux: number;
    uy: number;
  } | null;
};

/**
 * d = the route (absolute M / L / C / Q); w0 / w1 = the line's width at its source / at its end (the width falls evenly with
 * the distance along it); upto = how much of it, from the source, is drawn (0..1). The same arguments always give the same outline
 */
export function taperLine(d: string, w0 = 2.5, w1 = 0.9, upto = 1): Taper {
  const walk = pathWalker(d);
  if (!walk) return { d: "", end: null };
  const { L, at } = walk;
  const u = Math.min(1, Math.max(0, upto)),
    len = L * u;
  // a point every ~6px, at least 8, at most 60: smooth on the curves, cheap on the long lines
  const N = Math.max(8, Math.min(60, Math.round(len / 6)));
  let lt = "",
    rt = "";
  let x0 = 0,
    y0 = 0,
    last = at(0);
  for (let i = 0; i <= N; i++) {
    const s = (len * i) / N,
      p = at(s),
      h = (w0 + (w1 - w0) * (s / L)) / 2;
    const lx = p.x - p.ty * h,
      ly = p.y + p.tx * h;
    if (i) lt += `L${f(lx)} ${f(ly)}`;
    else {
      x0 = lx;
      y0 = ly;
    }
    rt = `L${f(p.x + p.ty * h)} ${f(p.y - p.tx * h)}${rt}`;
    last = p;
  }
  // along one side to the end, back along the other, and a round cap at the source from the second side back to the first
  const r = f(w0 / 2);
  return {
    d: `M${f(x0)} ${f(y0)}${lt}${rt}A${r} ${r} 0 0 0 ${f(x0)} ${f(y0)}Z`,
    end: { x: last.x, y: last.y, ux: last.tx, uy: last.ty },
  };
}
