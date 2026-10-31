// 手绘线：从 Mark（标注卡）出发的箭头画成这样。走线还是 route.ts 算出来的三次贝塞尔，这里只改画法：
// 沿弧长取点，往法线方向加两层平滑的波动和一个整体的弓形；两端 30px 内收为 0，所以线一定落在端点上。
// 波动的相位由箭头 id 定：拖卡时线会拉长、变形，但同一条线的笔迹保持连贯，不会每帧随机。
// 第二笔用另一组相位，略短、略淡；箭头是两道略弯的短笔画。纯计算（不碰 DOM）。

import { clamp } from "./geom";

/** 抖动的幅度（A）和弓形（B） */
const A = 1.9, B = 5;

/** 箭头 id → 种子（FNV-1a） */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** 由种子定下来的一串 0..1（mulberry32） */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type P = { x: number; y: number };
const bez = (c: readonly number[], t: number): P => {
  const u = 1 - t;
  return { x: u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6], y: u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7] };
};

/** 沿曲线从弧长比例 from 到 to 取点，往法线方向偏；amp = 波动幅度，bow = 弓形（第二笔跟着主笔的弓形），shift = 整体平移 */
function wobble(c: readonly number[], rand: () => number, amp: number, bow: number, from: number, to: number, shift: number): P[] {
  const n = 24, raw: P[] = [], len = [0];
  for (let i = 0; i <= n; i++) {
    raw.push(bez(c, i / n));
    if (i) len.push(len[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y));
  }
  const L = len[n] || 1, m = clamp(Math.round(L / 16), 8, 40);
  const ph1 = rand() * 6.283, ph2 = rand() * 6.283, f1 = 6.283 / (110 + rand() * 60), f2 = 6.283 / (38 + rand() * 20);
  const out: P[] = [];
  let j = 0;
  for (let i = 0; i <= m; i++) {
    const s = L * (from + ((to - from) * i) / m);
    while (j < n - 1 && len[j + 1] < s) j++;
    const k = (s - len[j]) / (len[j + 1] - len[j] || 1), a = raw[j], b = raw[j + 1];
    const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot(tx, ty) || 1;
    const env = Math.sin((Math.PI * clamp(Math.min(s, L - s) / Math.min(30, L / 2), 0, 1)) / 2);
    const off = env * (amp * (0.65 * Math.sin(s * f1 + ph1) + 0.35 * Math.sin(s * f2 + ph2)) + bow * Math.sin((Math.PI * s) / L)) + shift;
    out.push({ x: a.x + tx * k - (ty / tl) * off, y: a.y + ty * k + (tx / tl) * off });
  }
  return out;
}

/** 点串 → 平滑的 path（二次曲线过各段中点）。整数坐标：小数转字符串是这里最贵的一步，抖动的线上 0.5px 看不出来 */
function smooth(ps: P[]) {
  const R = Math.round, n = ps.length;
  let d = `M${R(ps[0].x)} ${R(ps[0].y)}`;
  for (let i = 1; i < n - 1; i++) { const a = ps[i], b = ps[i + 1]; d += `Q${R(a.x)} ${R(a.y)} ${R((a.x + b.x) / 2)} ${R((a.y + b.y) / 2)}`; }
  return `${d}L${R(ps[n - 1].x)} ${R(ps[n - 1].y)}`;
}

/** 手绘的箭头：尖在 tip，(ux, uy) 是来的方向；两道略弯的短笔画，角度、长度每条线稍有不同。s = 粗细档的放大 */
function headStrokes(tip: P, ux: number, uy: number, rand: () => number, s: number) {
  let d = "";
  for (const sg of [-1, 1]) {
    const ang = (0.46 + rand() * 0.12) * sg, len = (10 + rand() * 3.5) * s;
    const vx = -ux * Math.cos(ang) + uy * Math.sin(ang), vy = -ux * Math.sin(ang) - uy * Math.cos(ang);
    const ex = tip.x + vx * len, ey = tip.y + vy * len, bend = (rand() - 0.5) * 2.2;
    const mx = (tip.x + ex) / 2 - vy * bend, my = (tip.y + ey) / 2 + vx * bend;
    d += `M${ex.toFixed(1)} ${ey.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${(tip.x + ux * 0.6).toFixed(1)} ${(tip.y + uy * 0.6).toFixed(1)}`;
  }
  return d;
}

export type Hand = { d: string; d2: string; head?: string; tail?: string };

/**
 * 一条手绘线。c = 走线算出来的三次贝塞尔 [x1 y1 c1x c1y c2x c2y x2 y2]；end / start = 终点 / 起点画不画箭头。
 * 同一个 id、同一条贝塞尔永远画出同一个样子
 */
export function handLine(id: string, c: readonly number[], end: boolean, start: boolean, s = 1): Hand {
  const rand = rng(hash(id));
  const bow = (rand() < 0.5 ? -1 : 1) * B * (0.6 + rand() * 0.4);
  const p1 = wobble(c, rand, A, bow, 0, 1, 0);
  const p2 = wobble(c, rand, A * 0.8, bow * (0.85 + rand() * 0.25), 0.03 + rand() * 0.03, 0.94 + rand() * 0.03, (rand() - 0.5) * 1.6);
  const dir = (a: P, b: P) => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
  const n = p1.length, ue = dir(p1[n - 3], p1[n - 1]), us = dir(p1[2], p1[0]);
  return {
    d: smooth(p1), d2: smooth(p2),
    head: end ? headStrokes(p1[n - 1], ue.x, ue.y, rand, s) : undefined,
    tail: start ? headStrokes(p1[0], us.x, us.y, rand, s) : undefined,
  };
}
