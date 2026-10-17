// 标签框沿线的位置（纯几何，不碰 DOM）：存的是线上的比例 t（0..1，三次贝塞尔的参数），框不压到两端的卡上。
import type { Rect } from "@codeboard/core";

export type Box = { w: number; h: number };
/** 框离卡边至少留这么多（世界坐标 px） */
export const LABEL_GAP = 6;

/** 三次贝塞尔 [x1 y1 c1x c1y c2x c2y x2 y2] 在 t 处的点 */
export function bezAt(p: number[], t: number) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7] };
}

/** 以 (x, y) 为中心的框碰不碰到这些矩形（留 gap） */
export function boxClear(x: number, y: number, box: Box, rs: Rect[], gap = LABEL_GAP) {
  const hw = box.w / 2 + gap, hh = box.h / 2 + gap;
  for (const r of rs) if (x + hw > r.x && x - hw < r.x + r.w && y + hh > r.y && y - hh < r.y + r.h) return false;
  return true;
}

/**
 * 拖动时：线上离指针最近、框又不压到两端卡上的 t（按 0.01 取样，存两位小数）。
 * 整条线上都放不下（两张卡挨得太近）时回到中间
 */
export function dragT(p: number[], x: number, y: number, box: Box, rs: Rect[], gap = LABEL_GAP): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i <= 100; i++) {
    const q = bezAt(p, i / 100);
    if (!boxClear(q.x, q.y, box, rs, gap)) continue;
    const d = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best < 0 ? 0.5 : best / 100;
}

/**
 * 显示时：存的 t 处框压到卡上了（卡挪近了、线变短了），就往中间挪到第一个不压的地方；不压就原样。
 * 一般第一次就不压（每帧只多两个矩形比较）；一路挪到中间还压着就放中间
 */
export function placeT(p: number[], t: number, box: Box, rs: Rect[], gap = LABEL_GAP): number {
  const step = t < 0.5 ? 0.02 : -0.02;
  for (let i = 0; i < 26; i++) {
    const u = i === 0 ? t : t + step * i;
    if ((step > 0 && u > 0.5) || (step < 0 && u < 0.5)) break;
    const q = bezAt(p, u);
    if (boxClear(q.x, q.y, box, rs, gap)) return u;
  }
  return 0.5;
}
