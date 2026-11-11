// Brush strokes (Ink Wash): a route (route.ts's path) drawn as a filled outline instead of a stroked line. Points along the
// path by arc length, offset to both sides by half the brush width: a heavier, rounded start, tapering towards the end, with a
// faint wobble whose phase comes from the link's id (one link always looks the same). Three paper-coloured hairlines along the
// middle are the dry brush (飞白). Pure computation, no DOM; the board recomputes it only when a link's geometry changes.

import { fnv } from "@codeboard/analysis/basics";

/** A path of absolute M / L / C / Q commands (what route.ts and the ink images write) → a polyline */
function flatten(d: string): number[] {
  const tok = d.match(/[MLCQ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const out: number[] = [];
  let i = 0,
    cmd = "",
    x = 0,
    y = 0;
  const num = () => Number(tok[i++]);
  // a repeated point would be a segment with no direction, which pinches the outline to nothing there
  const push = (px: number, py: number) => {
    const m = out.length;
    if (m < 2 || Math.abs(out[m - 2] - px) > 1e-6 || Math.abs(out[m - 1] - py) > 1e-6) out.push(px, py);
  };
  while (i < tok.length) {
    if (/[MLCQ]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M" || cmd === "L") {
      x = num();
      y = num();
      push(x, y);
    } else if (cmd === "C" || cmd === "Q") {
      const n = cmd === "C" ? 3 : 2,
        p = [x, y];
      for (let k = 0; k < n; k++) p.push(num(), num());
      // By the control polygon's length, not the chord's: a tight bend has a short chord but turns a lot. A Q is a rounded
      // corner (route.ts): at least 8 steps keep its quarter turn round under the brush's width
      let poly = 0;
      for (let k = 2; k < p.length; k += 2) poly += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
      const steps = Math.max(n === 2 ? 8 : 4, Math.min(64, Math.round(poly / 8)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps,
          u = 1 - t;
        if (n === 3) {
          const a = u * u * u,
            b = 3 * u * u * t,
            c = 3 * u * t * t,
            e = t * t * t;
          push(a * p[0] + b * p[2] + c * p[4] + e * p[6], a * p[1] + b * p[3] + c * p[5] + e * p[7]);
        } else push(u * u * p[0] + 2 * u * t * p[2] + t * t * p[4], u * u * p[1] + 2 * u * t * p[3] + t * t * p[5]);
      }
      x = p[p.length - 2];
      y = p[p.length - 1];
    } else i++;
  }
  return out;
}

/** Walks a path (absolute M / L / C / Q) by arc length: L = its length, at(s) = the point and unit tangent at arc length s.
 *  s may only grow within one pass; reset() starts a new pass from the beginning. null for a path of fewer than two points */
export function pathWalker(d: string) {
  const pl = flatten(d),
    n = pl.length / 2;
  if (n < 2) return null;
  const acc = [0];
  for (let k = 1; k < n; k++)
    acc.push(acc[k - 1] + Math.hypot(pl[2 * k] - pl[2 * k - 2], pl[2 * k + 1] - pl[2 * k - 1]));
  let j = 0;
  const at = (s: number) => {
    if (s < acc[j]) j = 0;
    while (j < n - 2 && acc[j + 1] < s) j++;
    const seg = acc[j + 1] - acc[j] || 1,
      k = Math.min(1, Math.max(0, (s - acc[j]) / seg));
    const x0 = pl[2 * j],
      y0 = pl[2 * j + 1],
      dx = pl[2 * j + 2] - x0,
      dy = pl[2 * j + 3] - y0,
      l = Math.hypot(dx, dy) || 1;
    return { x: x0 + dx * k, y: y0 + dy * k, tx: dx / l, ty: dy / l };
  };
  return {
    L: acc[n - 1] || 1,
    at,
    reset: () => {
      j = 0;
    },
  };
}

/** A link's id → its wobble phase, 0..2π */
export const brushSeed = (id: string) => (fnv(id) / 4294967296) * 6.283;

/** The width envelope over the stroke (t = share of its length): rises from 0.75 to 1.3 over the first 7%, then thins to 0.45 */
const headAt = (t: number) => (t < 0.07 ? 0.75 + (t / 0.07) * 0.55 : 1.3 - 0.85 * ((t - 0.07) / 0.93) ** 0.8);

const f = (n: number) => String(Math.round(n * 10) / 10);

export type Brush = {
  /** The filled outline */ d: string;
  /** Dry brush: three hairlines along the middle (stroked, paper coloured); empty on a short line */ fb: string;
};

/**
 * d = the route (absolute M / L / C / Q), seed = brushSeed(id), w = half the brush width (the widest point is 1.3 w).
 * The same d and seed always give the same stroke
 */
export function brushLine(d: string, seed: number, w = 1.5): Brush {
  const pl = flatten(d),
    n = pl.length / 2;
  if (n < 2) return { d: "", fb: "" };
  const acc = [0];
  for (let k = 1; k < n; k++)
    acc.push(acc[k - 1] + Math.hypot(pl[2 * k] - pl[2 * k - 2], pl[2 * k + 1] - pl[2 * k - 1]));
  const L = acc[n - 1] || 1;
  const dir = (k: number) => {
    const dx = pl[2 * k + 2] - pl[2 * k],
      dy = pl[2 * k + 3] - pl[2 * k + 1],
      l = Math.hypot(dx, dy) || 1;
    return { tx: dx / l, ty: dy / l };
  };
  // The tangent at each vertex: the mean of its two segments'. Between vertices it turns evenly from one to the next, so the
  // offset sides follow the path's bends instead of jumping at every vertex
  const tan: { tx: number; ty: number }[] = [];
  for (let k = 0; k < n; k++) {
    const a = dir(Math.max(0, k - 1)),
      b = dir(Math.min(n - 2, k)),
      mx = a.tx + b.tx,
      my = a.ty + b.ty,
      ml = Math.hypot(mx, my);
    tan.push(ml > 1e-6 ? { tx: mx / ml, ty: my / ml } : b);
  }
  // The point and unit tangent at arc length s (s only grows within one pass; a smaller s starts over)
  let j = 0;
  const at = (s: number) => {
    if (s < acc[j]) j = 0;
    while (j < n - 2 && acc[j + 1] < s) j++;
    const seg = acc[j + 1] - acc[j] || 1,
      k = Math.min(1, Math.max(0, (s - acc[j]) / seg)),
      a = tan[j],
      b = tan[j + 1],
      tx = a.tx + (b.tx - a.tx) * k,
      ty = a.ty + (b.ty - a.ty) * k,
      tl = Math.hypot(tx, ty) || 1;
    return {
      x: pl[2 * j] + (pl[2 * j + 2] - pl[2 * j]) * k,
      y: pl[2 * j + 1] + (pl[2 * j + 3] - pl[2 * j + 1]) * k,
      tx: tx / tl,
      ty: ty / tl,
    };
  };
  // Even steps along the length, plus every vertex where the path turns: a rounded corner is shorter than one even step on a
  // long line, and sampled only by the even steps it came out as a chamfer with a kink (#135)
  const N = Math.max(12, Math.min(80, Math.round(L / 7)));
  const ss: number[] = [];
  for (let i = 0; i <= N; i++) ss.push((i / N) * L);
  for (let k = 1; k < n - 1; k++) {
    const a = dir(k - 1),
      b = dir(k);
    if (a.tx * b.tx + a.ty * b.ty < 0.9995) ss.push(acc[k]);
  }
  ss.sort((u, v) => u - v);
  const lx: number[] = [],
    rx: number[] = [];
  for (const s of ss) {
    const p = at(s);
    const t = s / L;
    const h = w * headAt(t) * (1 + 0.07 * Math.sin(t * 19 + seed) + 0.04 * Math.sin(t * 47 + seed * 2));
    lx.push(p.x - p.ty * h, p.y + p.tx * h);
    rx.push(p.x + p.ty * h, p.y - p.tx * h);
  }
  let out = `M${f(lx[0])} ${f(lx[1])}`;
  for (let i = 2; i < lx.length; i += 2) out += `L${f(lx[i])} ${f(lx[i + 1])}`;
  for (let i = rx.length - 2; i >= 0; i -= 2) out += `L${f(rx[i])} ${f(rx[i + 1])}`;
  // the rounded start: an arc from the start of one side back to the other
  out += `A${f(w * 0.9)} ${f(w * 0.9)} 0 0 1 ${f(lx[0])} ${f(lx[1])}Z`;
  let fb = "";
  if (L >= 60)
    for (const [o, a, b] of [
      [-0.35, 0.32, 0.62],
      [0.3, 0.42, 0.78],
      [0.05, 0.55, 0.7],
    ]) {
      j = 0;
      for (let i = 0; i <= 12; i++) {
        const t = a + ((b - a) * i) / 12,
          p = at(t * L),
          off = o * w * headAt(t) * 2;
        fb += `${i ? "L" : "M"}${f(p.x - p.ty * off)} ${f(p.y + p.tx * off)}`;
      }
    }
  return { d: out, fb };
}
