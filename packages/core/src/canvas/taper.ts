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
  if (upto >= 1) return taperWhole(d, w0, w1);
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

type P = { x: number; y: number };
/** One piece of a route: a straight line (2 points) or a cubic (4 points); a Q is raised to the cubic it is exactly */
type Seg = P[];

function segments(d: string): Seg[] {
  const tok = d.match(/[MLCQ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const out: Seg[] = [];
  let i = 0,
    cmd = "",
    at: P = { x: 0, y: 0 };
  const pt = (): P => ({ x: Number(tok[i++]), y: Number(tok[i++]) });
  while (i < tok.length) {
    if (/[MLCQ]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M") at = pt();
    else if (cmd === "L") {
      const b = pt();
      if (Math.hypot(b.x - at.x, b.y - at.y) > 1e-6) out.push([at, b]);
      at = b;
    } else if (cmd === "C") {
      const c1 = pt(),
        c2 = pt(),
        b = pt();
      if (Math.hypot(b.x - at.x, b.y - at.y) + Math.hypot(c1.x - at.x, c1.y - at.y) > 1e-6) out.push([at, c1, c2, b]);
      at = b;
    } else if (cmd === "Q") {
      const q = pt(),
        b = pt();
      out.push([
        at,
        { x: at.x + ((q.x - at.x) * 2) / 3, y: at.y + ((q.y - at.y) * 2) / 3 },
        { x: b.x + ((q.x - b.x) * 2) / 3, y: b.y + ((q.y - b.y) * 2) / 3 },
        b,
      ]);
      at = b;
    } else i++;
  }
  return out;
}

const dist = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y);
/** The unit direction from a to the first of bs that is not on it */
function dir(a: P, ...bs: P[]): P {
  for (const b of bs) {
    const l = dist(a, b);
    if (l > 1e-6) return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  }
  return { x: 1, y: 0 };
}

/**
 * The whole line: each piece of the route offset to both sides by its own control points (a cubic's two near its start move
 * with the start's normal, the two near its end with the end's), the half width falling with the distance along it. A few
 * curve commands per piece instead of a point every few pixels: arrows are redrawn every frame while a card is dragged
 */
/** A cubic split in two halves at t = 0.5 (de Casteljau) */
function halves([a, b, c, e]: Seg): [Seg, Seg] {
  const m = (p: P, q: P): P => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  const ab = m(a, b),
    bc = m(b, c),
    ce = m(c, e),
    abc = m(ab, bc),
    bce = m(bc, ce),
    mid = m(abc, bce);
  return [
    [a, ab, abc, mid],
    [mid, bce, ce, e],
  ];
}

/** A cubic cut in halves (at most `depth` times over) until no piece turns more than ~35° from its start to its middle or from
 *  its middle to its end; a gentle curve stays one piece */
function bendy(g: Seg, depth: number): Seg[] {
  const [a, b, c, e] = g,
    s = dir(a, b, c, e),
    t = dir(c, e),
    m = dir({ x: a.x + b.x, y: a.y + b.y }, { x: c.x + e.x, y: c.y + e.y });
  const dot = (p: P, q: P) => p.x * q.x + p.y * q.y;
  if (!depth || (dot(s, m) > 0.82 && dot(m, t) > 0.82)) return [g];
  const [h1, h2] = halves(g);
  return [...bendy(h1, depth - 1), ...bendy(h2, depth - 1)];
}

function taperWhole(d: string, w0: number, w1: number): Taper {
  // Offsetting a cubic by its control points holds while it turns little: a route's curve can turn up to a half turn (an S from a
  // row down to a card), whose middle would come out with no width, so a curve that turns much is cut first (bendy)
  const segs = segments(d).flatMap((g) => (g.length === 2 ? [g] : bendy(g, 2)));
  if (!segs.length) return { d: "", end: null };
  const lens = segs.map((g) =>
    g.length === 2 ? dist(g[0], g[1]) : (dist(g[0], g[3]) + dist(g[0], g[1]) + dist(g[1], g[2]) + dist(g[2], g[3])) / 2,
  );
  const L = lens.reduce((a, b) => a + b, 0) || 1;
  const half = (s: number) => (w0 + ((w1 - w0) * s) / L) / 2;
  const off = (p: P, n: P, h: number, side: number) => `${f(p.x - n.y * h * side)} ${f(p.y + n.x * h * side)}`;
  let lt = "",
    rt = "",
    s0 = 0,
    first = "",
    end: Taper["end"] = null;
  segs.forEach((g, k) => {
    const len = lens[k],
      a = g[0],
      b = g[g.length - 1];
    // the directions the piece leaves its start and reaches its end (a cubic's control point may sit on its end point)
    const na = g.length === 2 ? dir(a, b) : dir(a, g[1], g[2], b),
      back = g.length === 2 ? na : dir(b, g[2], g[1], a),
      n1 = g.length === 2 ? na : { x: 0 - back.x, y: 0 - back.y };
    const ha = half(s0),
      hb = half(s0 + len);
    const start = off(a, na, ha, 1);
    if (!k) first = start;
    if (k) lt += `L${start}`;
    if (g.length === 2) {
      lt += `L${off(b, na, hb, 1)}`;
      rt = `L${off(a, na, ha, -1)}${rt}`;
      rt = `L${off(b, na, hb, -1)}${rt}`;
    } else {
      const h1 = half(s0 + len / 3),
        h2 = half(s0 + (2 * len) / 3);
      lt += `C${off(g[1], na, h1, 1)} ${off(g[2], n1, h2, 1)} ${off(b, n1, hb, 1)}`;
      // the other side runs backwards: from this piece's end to its start
      rt = `L${off(b, n1, hb, -1)}C${off(g[2], n1, h2, -1)} ${off(g[1], na, h1, -1)} ${off(a, na, ha, -1)}${rt}`;
    }
    s0 += len;
    end = { x: b.x, y: b.y, ux: n1.x, uy: n1.y };
  });
  const r = f(w0 / 2);
  return { d: `M${first}${lt}${rt}A${r} ${r} 0 0 0 ${first}Z`, end };
}
