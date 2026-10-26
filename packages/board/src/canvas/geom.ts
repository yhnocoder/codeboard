// 画布上的纯几何（不碰 DOM、不读 store）：箭头、标签框、贴纸共用。
// 线都是三次贝塞尔 [x1 y1 c1x c1y c2x c2y x2 y2]

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function bezAt(p: number[], t: number) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7] };
}

/** 线上离 (x, y) 最近的那一点的 t（按 0.01 取样）；ok 过滤掉不能放的点，一个都不能放时回到中间 */
export function nearestT(p: number[], x: number, y: number, ok?: (q: { x: number; y: number }) => boolean) {
  let best = 0.5, bd = Infinity;
  for (let i = 0; i <= 100; i++) {
    const q = bezAt(p, i / 100);
    if (ok && !ok(q)) continue;
    const d = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d < bd) { bd = d; best = i / 100; }
  }
  return best;
}
