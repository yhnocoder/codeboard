// 画布上的纯几何（不碰 DOM、不读 store）。
// 线都是三次贝塞尔 [x1 y1 c1x c1y c2x c2y x2 y2]

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function bezAt(p: number[], t: number) {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return { x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7] };
}

/** The box a curve really covers (its control points can stick out much further): the ends plus where x or y turns */
export function bezBox(p: number[]) {
  const lo = [Math.min(p[0], p[6]), Math.min(p[1], p[7])],
    hi = [Math.max(p[0], p[6]), Math.max(p[1], p[7])];
  for (const k of [0, 1]) {
    const a0 = p[k],
      a1 = p[k + 2],
      a2 = p[k + 4],
      a3 = p[k + 6];
    // B'(t) / 3 = a t² + b t + c
    const a = -a0 + 3 * a1 - 3 * a2 + a3,
      b = 2 * (a0 - 2 * a1 + a2),
      c = a1 - a0;
    const d = b * b - 4 * a * c;
    const ts =
      Math.abs(a) < 1e-9
        ? Math.abs(b) < 1e-9
          ? []
          : [-c / b]
        : d < 0
          ? []
          : [(-b + Math.sqrt(d)) / (2 * a), (-b - Math.sqrt(d)) / (2 * a)];
    for (const t of ts) {
      if (!(t > 0 && t < 1)) continue;
      const u = 1 - t,
        v = u * u * u * a0 + 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t * a3;
      lo[k] = Math.min(lo[k], v);
      hi[k] = Math.max(hi[k], v);
    }
  }
  return { x: lo[0], y: lo[1], w: hi[0] - lo[0], h: hi[1] - lo[1] };
}

/** 线上离 (x, y) 最近的那一点的 t（按 0.01 取样）；ok 过滤掉不能放的点，一个都不能放时回到中间 */
export function nearestT(p: number[], x: number, y: number, ok?: (q: { x: number; y: number }) => boolean) {
  let best = 0.5,
    bd = Infinity;
  for (let i = 0; i <= 100; i++) {
    const q = bezAt(p, i / 100);
    if (ok && !ok(q)) continue;
    const d = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = i / 100;
    }
  }
  return best;
}
