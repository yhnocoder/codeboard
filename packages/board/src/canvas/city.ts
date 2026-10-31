// 纯计算，不碰 DOM、不读 store。
import type { Pt } from "@codeboard/core/canvas";

const r = (v: number) => Math.round(v * 10) / 10;

/** City：停在路尽头的小车的位置（carPaths 按它画）。车头在原点朝 +x；(tx, ty) 是平移，deg 是转角（度），s 是放大；tx、ty、deg 按 0.1 取整 */
export type CarPose = { tx: number; ty: number; deg: number; s: number };
/** tip 是车头，(ux, uy) 是开过来的方向 */
export function carAt(tx: number, ty: number, ux: number, uy: number, s = 1): CarPose {
  return { tx: r(tx - ux), ty: r(ty - uy), deg: r((Math.atan2(uy, ux) * 180) / Math.PI), s };
}
/**
 * City：把 carAt 的位置直接画进三条 path（车身、车顶、两个车灯），世界坐标。拖动时每帧要重画整层线，
 * 每辆车带一个 transform 会多出一个绘制块，两百辆车就让 Layerize / Paint 每帧多 3 ms 左右；烤进坐标就没有这笔开销
 */
export function carPaths({ tx, ty, deg, s }: CarPose, road?: Road) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a) * s, sn = Math.sin(a) * s;
  const P = (x: number, y: number) => `${r(tx + x * c - y * sn)} ${r(ty + x * sn + y * c)}`;
  const rr = (x: number, y: number, w: number, h: number, k: number) => {
    const R = r(k * s), A = `A${R} ${R} 0 0 1 `;
    return `M${P(x + k, y)}L${P(x + w - k, y)}${A}${P(x + w, y + k)}L${P(x + w, y + h - k)}${A}${P(x + w - k, y + h)}L${P(x + k, y + h)}${A}${P(x, y + h - k)}L${P(x, y + k)}${A}${P(x + k, y)}Z`;
  };
  // 有人行横道时车往回停，车头离横道留一点
  const z = road ? ZEBRA[road] : undefined, b = z ? -zebraBack(road!) : 0;
  let zebra = "";
  if (z) for (let i = 0; i < z.n; i++) {
    const y = -z.span / 2 + i * (z.span - z.w) / (z.n - 1), x0 = -0.5 - z.len, x1 = -0.5;
    zebra += `M${P(x0, y)}L${P(x1, y)}L${P(x1, y + z.w)}L${P(x0, y + z.w)}Z`;
  }
  return { body: rr(b - 23, -5, 23, 10, 3.5), roof: rr(b - 15.5, -3.8, 9.5, 7.6, 1.6), lamp: rr(b - 2.2, -4.2, 1.6, 2.4, 0.6) + rr(b - 2.2, 1.8, 1.6, 2.4, 0.6) + zebra };
}
/** City 的路：调用是大路（main），普通箭头是小街（street） */
export type Road = "main" | "street";
/**
 * 人行横道（路和卡片相接的那头，车前面）：顺着路的白条，横着排满路面。len = 顺着路多长，n 条、每条 w 宽，一共占 span 宽（车的坐标，跟着车放大）。
 * 画进车灯那条 path（同一个颜色），不多一个节点
 */
const ZEBRA: Record<Road, { len: number; n: number; w: number; span: number }> = { main: { len: 7, n: 4, w: 1.7, span: 11.2 }, street: { len: 5, n: 3, w: 1, span: 5 } };
/** 车往回停多少（车的坐标）：横道的长度 + 车头前空一点 */
export const zebraBack = (road: Road) => ZEBRA[road].len + 2.5;
/**
 * City 的路面标线：沿折线 d（City 的路是直角折线）两头各剪掉 t0 / t1（停车、人行横道那段不画），
 * gap > 0 时是左右各偏 gap 的两条线（双黄线，一个 path），否则就是剪过的那一条（小街的白中线）
 */
export function laneOf(d: string, gap: number, t0 = 0, t1 = 0) {
  const n = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
  let pts: Pt[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) { const p = { x: n[i], y: n[i + 1] }, q = pts[pts.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.01) pts.push(p); }
  if (pts.length < 2) return "";
  const cut = (ps: Pt[], t: number) => {
    // 从 ps[0] 那头剪掉 t
    while (t > 0 && ps.length >= 2) {
      const l = Math.hypot(ps[1].x - ps[0].x, ps[1].y - ps[0].y);
      if (l > t) { const k = t / l; ps[0] = { x: ps[0].x + (ps[1].x - ps[0].x) * k, y: ps[0].y + (ps[1].y - ps[0].y) * k }; return ps; }
      t -= l; ps.shift();
    }
    return ps;
  };
  pts = cut(pts, t0);
  pts = cut(pts.reverse(), t1).reverse();
  if (pts.length < 2) return "";
  const line = (ps: Pt[]) => "M" + ps.map((p) => `${r(p.x)} ${r(p.y)}`).join("L");
  if (!gap) return line(pts);
  const nrm = (a: Pt, b: Pt) => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }; };
  const off = (g: number) => pts.map((p, i) => {
    const n1 = i > 0 ? nrm(pts[i - 1], p) : nrm(p, pts[i + 1]), n2 = i < pts.length - 1 ? nrm(p, pts[i + 1]) : n1;
    const m = { x: n1.x + n2.x, y: n1.y + n2.y }, ml = Math.hypot(m.x, m.y);
    if (ml < 1e-6) return { x: p.x + n1.x * g, y: p.y + n1.y * g };
    const k = g / Math.max(0.3, (m.x * n1.x + m.y * n1.y) / ml) / ml;
    return { x: p.x + m.x * k, y: p.y + m.y * k };
  });
  return line(off(gap)) + line(off(-gap));
}
/**
 * City 的车流：沿一条折线开过去的关键帧（只有 transform，交给合成器跑，不用每帧算）。d 里的点按折线连（City 的路是直角折线）。
 * 拐角前后 turn 像素里转过去；车靠右行驶（离中线 lane 像素）。车是 w × h 的小块，左上角在原点
 */
export function driveFrames(d: string, w = 22, h = 10, lane = 3.5, turn = 7) {
  const n = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) { const p = { x: n[i], y: n[i + 1] }, q = pts[pts.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.01) pts.push(p); }
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const len = cum[cum.length - 1];
  // 每段的方向（度），接着上一段展开，转弯总是走近的那边
  const ang: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    let a = (Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) * 180) / Math.PI;
    const prev = ang[ang.length - 1];
    if (prev !== undefined) { while (a - prev > 180) a -= 360; while (a - prev < -180) a += 360; }
    ang.push(a);
  }
  const at = (s: number) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  };
  const stops: { s: number; a: number }[] = [{ s: 0, a: ang[0] }];
  for (let i = 1; i < pts.length - 1; i++) {
    const t = Math.min(turn, (cum[i] - cum[i - 1]) / 2, (cum[i + 1] - cum[i]) / 2);
    stops.push({ s: cum[i] - t, a: ang[i - 1] }, { s: cum[i] + t, a: ang[i] });
  }
  stops.push({ s: len, a: ang[ang.length - 1] });
  const frames = stops.map(({ s, a }) => {
    const p = at(s);
    return { offset: len ? s / len : 0, transform: `translate(${r(p.x)}px, ${r(p.y)}px) rotate(${r(a)}deg) translate(${-w / 2}px, ${lane - h / 2}px)` };
  });
  return { len, frames };
}
