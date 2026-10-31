// 纯计算：不碰 DOM、不读 store（Links.tsx 每条线一个 memo 调这里）。

import { bezAt, clamp } from "./geom";

export type Side = "left" | "right" | "top" | "bottom";
export type Box = { x: number; y: number; w: number; h: number };
/**
 * 两张卡的摆法（从起点看）：sepR / sepL = 左右分开（终点在右 / 在左）；stackR / stackL = 上下摆放、有一端是行，C 形走右 / 左；
 * down / up = 上下摆放、两端都是卡，终点在下 / 在上
 */
export type Mode = "sepR" | "sepL" | "stackR" | "stackL" | "down" | "up";
export type Pt = { x: number; y: number };
/** nx, ny：朝卡外的方向（单位向量） */
export type Anchor = { x: number; y: number; nx: number; ny: number };

/**
 * 直角折线绕到卡外面时，竖（横）的那段离卡边多远。默认 24；City 的路有 16px 宽的路沿，
 * 材质给更大的值（shape().clear），路和卡边之间留出一条路宽，汇在一起的主干不贴着卡走
 */
const CLEAR = 24;

const cx = (b: Box) => b.x + b.w / 2, cy = (b: Box) => b.y + b.h / 2;

/** 左右相对至少要这么宽的缝：再窄，中间那一折看不出来、箭头会压到起点卡上（贴在一起时根本出不去） */
const FACE = 8;

/**
 * 按两张卡的左右关系定摆法。H = 换边缓冲：从「上下」换成「左右分开」要拉开 H，分开以后要重叠才换回来；
 * C 形的左右、卡↔卡的上下也要越过 H 才换（来回拖不抖）。prev = 这条线上一次的结果（没有 = 第一次画）
 */
export function chooseMode(a: Box, b: Box, cards: boolean, prev: Mode | undefined, H: number): Mode {
  const gapR = b.x - (a.x + a.w), gapL = a.x - (b.x + b.w);
  if (gapR >= Math.max(FACE, prev === "sepR" ? 0 : H)) return "sepR";
  if (gapL >= Math.max(FACE, prev === "sepL" ? 0 : H)) return "sepL";
  if (cards) {
    // 上下没错开（两张卡并排、只是离得近）：上下边连不过去（绕出来的线会穿过卡），还是左右相对，中间走短线。
    // 上下摆着的要重叠过 H 才换过来，来回拖不抖
    const vgap = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)), vert = prev === "down" || prev === "up";
    if (vgap < (vert ? -H : 0)) {
      if (gapR >= FACE) return "sepR";
      if (gapL >= FACE) return "sepL";
    }
    // 上下也挨着：左右并排贴着（同一侧的 C 形出不去）时还是上下边、绕过去；左右叠着就跟行端一样走同一侧的 C 形
    if (vgap >= FACE || Math.max(gapR, gapL) >= 0) {
      const d = cy(b) - cy(a);
      if (prev === "down" && d > -H) return "down";
      if (prev === "up" && d < H) return "up";
      return d >= 0 ? "down" : "up";
    }
  }
  const d = cx(b) - cx(a);
  if (prev === "stackR" && d > -H) return "stackR";
  if (prev === "stackL" && d < H) return "stackL";
  return d >= 0 ? "stackR" : "stackL";
}

export function sidesOf(m: Mode): [Side, Side] {
  switch (m) {
    case "sepR": return ["right", "left"];
    case "sepL": return ["left", "right"];
    case "stackR": return ["right", "right"];
    case "stackL": return ["left", "left"];
    case "down": return ["bottom", "top"];
    case "up": return ["top", "bottom"];
  }
}

const normalOf = (s: Side): Pt => (s === "left" ? { x: -1, y: 0 } : s === "right" ? { x: 1, y: 0 } : s === "top" ? { x: 0, y: -1 } : { x: 0, y: 1 });

/** 端点：行端在那一行的左 / 右边；卡端在左右边时落在卡头那一行（rowY），上下边时在边的正中 */
export function anchorOn(b: Box, side: Side, rowY: number): Anchor {
  const n = normalOf(side);
  if (side === "left") return { x: b.x, y: rowY, nx: n.x, ny: n.y };
  if (side === "right") return { x: b.x + b.w, y: rowY, nx: n.x, ny: n.y };
  if (side === "top") return { x: cx(b), y: b.y, nx: n.x, ny: n.y };
  return { x: cx(b), y: b.y + b.h, nx: n.x, ny: n.y };
}

/** 斜贴的卡（转了 rad，绕 b 的中心）：端点跟着边转过去，朝外的方向也一起转 */
export function turnAnchor(a: Anchor, b: Box, rad: number): Anchor {
  const c = Math.cos(rad), s = Math.sin(rad), dx = a.x - cx(b), dy = a.y - cy(b);
  return { x: cx(b) + dx * c - dy * s, y: cy(b) + dx * s + dy * c, nx: a.nx * c - a.ny * s, ny: a.nx * s + a.ny * c };
}

/** 换边时端点滑过去：位置直线插值，朝向按角度插值（左右对调时从下面转过去） */
export function slide(a: Anchor, b: Anchor, p: number): Anchor {
  if (p >= 1) return b;
  const a0 = Math.atan2(a.ny, a.nx);
  let d = Math.atan2(b.ny, b.nx) - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(Math.abs(d) - Math.PI) < 1e-6) d = a.nx > 0 ? Math.PI : -Math.PI; // 正好对调：都从下面转
  const t = a0 + d * p;
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, nx: Math.cos(t), ny: Math.sin(t) };
}

const rot = (n: Pt, ang: number): Pt => ({ x: n.x * Math.cos(ang) - n.y * Math.sin(ang), y: n.x * Math.sin(ang) + n.y * Math.cos(ang) });
const MAX_TILT = Math.PI / 4;
/**
 * 终点正前方空间不够、侧向又偏得多时，方向朝对面那一端斜过去，最多 45°（不先拐直角再进）。
 * 前方空间够大时慢慢回到正对（≥ 160 不斜），所以远的线还是平着进出。返回转过的角（带符号）
 */
export function tiltAngle(p: Anchor, q: Pt): number {
  const dx = q.x - p.x, dy = q.y - p.y;
  const fwd = dx * p.nx + dy * p.ny, lat = dx * -p.ny + dy * p.nx;
  if (fwd <= 0) return 0;
  const fade = clamp((160 - fwd) / 80, 0, 1);
  if (!fade) return 0;
  const a = Math.min(MAX_TILT, 0.7 * Math.atan2(Math.abs(lat), fwd)) * fade;
  return lat >= 0 ? a : -a;
}

export type Shape = { d: string; pts: number[]; mx: number; my: number; /** 终点处线的来向（单位向量，指向终点） */ inDir: Pt; /** 起点处线的去向的反方向（从线指向起点） */ outDir: Pt };

/**
 * 两个端点之间的线。curve：三次贝塞尔；两端相对（左右分开 / 上下）时控制柄跟着距离变长，错位时两端斜着进出；
 * 同一侧（C 形）时控制点都在两张卡更外面那条边之外。tilt = false：不斜（合并到一点的那端，箭头在合并后的那一小段上）
 */
export function connect(p: Anchor, q: Anchor, route: "curve" | "elbow", tilt: { start: boolean; end: boolean } = { start: true, end: true }, boxes: { a?: Box; b?: Box } = {}, clear = CLEAR): Shape {
  const sh = direct(p, q, route, tilt, boxes, clear);
  // 上面的走法只看两个端点（加上「同侧绕过去」那一种）：两张卡挨得近、中间放不下出头和弯，或指定的边朝着另一张卡时，
  // 会穿过卡、箭头落在卡里。这时按两张卡找一条绕开的折线，最后一段一定从卡外朝着卡进来；曲线主题把拐角倒圆
  const obs = [boxes.a, boxes.b].filter((b): b is Box => !!b);
  if (!obs.length || !pathHits(sh.d, obs, route === "curve" ? 4 : 0.5)) return sh;
  const way = detour(p, q, obs, clear);
  return way ? (route === "elbow" ? polyline(p, q, way) : rounded(p, q, way)) : sh;
}
function direct(p: Anchor, q: Anchor, route: "curve" | "elbow", tilt: { start: boolean; end: boolean }, boxes: { a?: Box; b?: Box }, clear: number): Shape {
  const dot = p.nx * q.nx + p.ny * q.ny;
  // 同一侧、但起点在终点卡的里侧（或反过来），直着绕会穿过那张卡：从卡的下面 / 上面绕过去（比如 Compare 交换后从右边进）
  if (dot > 0.5 && p.ny === 0) {
    if (boxes.b && crosses(p, q, boxes.b)) return around(p, q, boxes.b, route, false, clear);
    if (boxes.a && crosses(q, p, boxes.a)) return around(q, p, boxes.a, route, true, clear);
  }
  if (route === "elbow") return elbow(p, q, dot, clear);
  const dx = q.x - p.x, dy = q.y - p.y, dist = Math.hypot(dx, dy);
  let d1: Pt = { x: p.nx, y: p.ny }, d2: Pt = { x: q.nx, y: q.ny };
  let k1: number, k2: number;
  if (dot < -0.5) {
    // 相对：沿 p 的方向往前多少、侧向偏多少
    const fwd = dx * p.nx + dy * p.ny, lat = Math.abs(dx * -p.ny + dy * p.nx);
    const base = fwd > 0 ? clamp(Math.abs(fwd) * 0.45 + lat * 0.3, 24, 180) : clamp(Math.abs(fwd) * 0.6 + lat * 0.3 + 40, 40, 240);
    const t1 = tilt.start ? tiltAngle(p, q) : 0, t2 = tilt.end ? tiltAngle(q, p) : 0;
    d1 = rot(d1, t1); d2 = rot(d2, t2);
    const w1 = Math.abs(t1) / MAX_TILT, w2 = Math.abs(t2) / MAX_TILT;
    k1 = base + (dist * 0.35 - base) * w1; k2 = base + (dist * 0.35 - base) * w2;
  } else if (dot > 0.5) {
    // 同一侧（C 形）：控制点放到两端更靠外的那条线之外
    const along = dx * p.nx + dy * p.ny, lat = Math.abs(dx * -p.ny + dy * p.nx);
    const out = clamp(28 + lat * 0.15, 28, 120);
    k1 = Math.max(0, along) + out; k2 = Math.max(0, -along) + out;
  } else {
    k1 = k2 = clamp(dist * 0.5, 30, 180);
  }
  const c1 = { x: p.x + d1.x * k1, y: p.y + d1.y * k1 }, c2 = { x: q.x + d2.x * k2, y: q.y + d2.y * k2 };
  const pts = [p.x, p.y, c1.x, c1.y, c2.x, c2.y, q.x, q.y];
  return {
    d: `M${r(p.x)} ${r(p.y)} C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(q.x)} ${r(q.y)}`, pts,
    mx: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, my: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8,
    inDir: unit(q.x - c2.x, q.y - c2.y, -q.nx, -q.ny), outDir: unit(p.x - c1.x, p.y - c1.y, -p.nx, -p.ny),
  };
}
const r = (v: number) => Math.round(v * 10) / 10;
function unit(x: number, y: number, fx: number, fy: number): Pt {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: fx, y: fy };
}

/** p 水平朝 n 出去到 q 外侧那条竖线的路上会不会穿过 q 的卡 b */
function crosses(p: Anchor, q: Anchor, b: Box) {
  if (p.y <= b.y + 4 || p.y >= b.y + b.h - 4) return false;
  return p.nx > 0 ? p.x < b.x + 4 && q.x >= b.x + b.w - 1 : p.x > b.x + b.w - 4 && q.x <= b.x + 1;
}
/** 绕过卡 b 到它这一侧：p 出去 → 卡下面（或上面）→ 进 q。rev = p 才是终点（起点在卡的这一侧，终点在外面） */
function around(p: Anchor, q: Anchor, b: Box, route: "curve" | "elbow", rev: boolean, clear = CLEAR): Shape {
  const below = p.y >= b.y + b.h / 2;
  const dy = Math.max(36, clear), dx = Math.max(30, clear);
  const yd = below ? b.y + b.h + dy : b.y - dy;
  const xo = p.nx > 0 ? b.x + b.w + dx : b.x - dx;
  const w = { x: (b.x + b.x + b.w) / 2, y: yd };
  let d: string, pts: number[];
  if (route === "elbow") {
    const xs = p.x + p.nx * 20;
    const ws = [{ x: p.x, y: p.y }, { x: xs, y: p.y }, { x: xs, y: yd }, { x: xo, y: yd }, { x: xo, y: q.y }, { x: q.x, y: q.y }];
    const all = rev ? ws.reverse() : ws;
    d = "M" + all.map((v) => `${r(v.x)} ${r(v.y)}`).join(" L");
    pts = rev ? [q.x, q.y, xo, q.y, xs, yd, p.x, p.y] : [p.x, p.y, xs, yd, xo, q.y, q.x, q.y];
  } else {
    // 两段：p → 卡下面（上面）靠近 p 的那个角 c，c → 沿卡底绕到另一侧进 q
    const s = Math.sign(p.nx), near = s > 0 ? b.x : b.x + b.w;
    const c = { x: near, y: yd };
    const k1 = clamp(Math.abs(near - p.x) * 0.5 + 20, 24, 80), k2 = clamp(Math.abs(yd - p.y) * 0.6, 20, 80);
    const a1 = { x: p.x + s * k1, y: p.y }, a2 = { x: near - s * k2, y: yd };
    // 卡底下直着走到另一个角 f，再弯上去进 q
    const f = { x: s > 0 ? b.x + b.w : b.x, y: yd }, kq = clamp(Math.abs(yd - q.y) * 0.45, 24, 70);
    const b1 = { x: f.x + s * kq, y: yd }, b2 = { x: Math.max(q.x * s, f.x * s) * s + s * kq, y: q.y };
    w.x = (near + f.x) / 2;
    const seg1 = `C${r(a1.x)} ${r(a1.y)} ${r(a2.x)} ${r(a2.y)} ${r(c.x)} ${r(c.y)}`, seg3 = `C${r(b1.x)} ${r(b1.y)} ${r(b2.x)} ${r(b2.y)} ${r(q.x)} ${r(q.y)}`;
    if (!rev) {
      d = `M${r(p.x)} ${r(p.y)} ${seg1} L${r(f.x)} ${r(f.y)} ${seg3}`;
      pts = [p.x, p.y, a1.x, yd, b2.x, yd, q.x, q.y];
    } else {
      d = `M${r(q.x)} ${r(q.y)} C${r(b2.x)} ${r(b2.y)} ${r(b1.x)} ${r(b1.y)} ${r(f.x)} ${r(f.y)} L${r(c.x)} ${r(c.y)} C${r(a2.x)} ${r(a2.y)} ${r(a1.x)} ${r(a1.y)} ${r(p.x)} ${r(p.y)}`;
      pts = [q.x, q.y, b2.x, yd, a1.x, yd, p.x, p.y];
    }
  }
  // 起点 / 终点处的方向（rev 时 p 是终点）
  const end = rev ? p : q, start = rev ? q : p;
  return { d, pts, mx: w.x, my: w.y, inDir: { x: -end.nx, y: -end.ny }, outDir: { x: -start.nx, y: -start.ny } };
}

/** 制图主题：直角折线。两端先沿各自的方向出去一小段，再横竖连起来；同一侧时竖的那段离更外面的卡边 clear */
function elbow(p: Anchor, q: Anchor, dot: number, clear = CLEAR): Shape {
  const S = 16;
  const ph = p.nx !== 0, qh = q.nx !== 0;
  let way: Pt[];
  if (ph && qh) {
    // 横进横出：相对 → 中间竖一段；同侧 → 在更外面竖一段
    const xm = dot < -0.5 && (q.x - p.x) * p.nx > 2 * S ? (p.x + q.x) / 2 : p.nx > 0 ? Math.max(p.x, q.x) + clear : Math.min(p.x, q.x) - clear;
    way = [{ x: xm, y: p.y }, { x: xm, y: q.y }];
  } else if (!ph && !qh) {
    const ym = dot < -0.5 && (q.y - p.y) * p.ny > 2 * S ? (p.y + q.y) / 2 : p.ny > 0 ? Math.max(p.y, q.y) + clear : Math.min(p.y, q.y) - clear;
    way = [{ x: p.x, y: ym }, { x: q.x, y: ym }];
  } else if (ph) way = [{ x: q.x, y: p.y }];
  else way = [{ x: p.x, y: q.y }];
  return polyline(p, q, way);
}
/** 横竖折线：p → 拐点们 → q */
function polyline(p: Anchor, q: Anchor, way: Pt[]): Shape {
  const all = [{ x: p.x, y: p.y }, ...way, { x: q.x, y: q.y }];
  const d = "M" + all.map((v) => `${r(v.x)} ${r(v.y)}`).join(" L");
  const a = way[0], b = way[way.length - 1];
  const mid = midOf(all);
  return {
    d, pts: [p.x, p.y, a.x, a.y, b.x, b.y, q.x, q.y], mx: mid.x, my: mid.y,
    inDir: unit(q.x - b.x, q.y - b.y, -q.nx, -q.ny), outDir: unit(p.x - a.x, p.y - a.y, -p.nx, -p.ny),
  };
}

/** 折线的中点：正中那一段的中点（偶数个点时就是中间那个拐角） */
function midOf(all: Pt[]): Pt {
  const n = all.length - 1, i = Math.floor(n / 2);
  if (n % 2 === 0) return all[i];
  return { x: (all[i].x + all[i + 1].x) / 2, y: (all[i].y + all[i + 1].y) / 2 };
}

/** 端点方向是不是正的横竖（斜贴的卡、换边滑动中不是：那时不绕） */
const axisOf = (a: Anchor): Pt | null =>
  Math.abs(a.nx) > 0.999 ? { x: Math.sign(a.nx), y: 0 } : Math.abs(a.ny) > 0.999 ? { x: 0, y: Math.sign(a.ny) } : null;

/** 一段直线有没有进到卡（往里缩 e）里面：裁剪到卡的范围，剩下的不为空就是进了 */
function lineHits(x1: number, y1: number, x2: number, y2: number, b: Box, e: number) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [pp, qq] of [[-dx, x1 - (b.x + e)], [dx, b.x + b.w - e - x1], [-dy, y1 - (b.y + e)], [dy, b.y + b.h - e - y1]]) {
    if (pp === 0) { if (qq <= 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}
/**
 * 画出来的 path（M / L / C / Q）有没有进到卡里：直线精确算，曲线取样。e = 进去多深才算
 * （曲线 4px：擦过卡角的弯不换走法；折线贴着边走不算）
 */
function pathHits(d: string, obs: Box[], e: number) {
  const tok = d.match(/[MLCQ]|-?[\d.]+/g) ?? [];
  let i = 0, x = 0, y = 0, cmd = "M";
  const num = () => +tok[i++];
  while (i < tok.length) {
    if (/[MLCQ]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M") { x = num(); y = num(); continue; }
    if (cmd === "L") {
      const x2 = num(), y2 = num();
      if (obs.some((b) => lineHits(x, y, x2, y2, b, e))) return true;
      x = x2; y = y2; continue;
    }
    // 二次的升成三次，一起取样
    const c = cmd === "Q" ? (() => { const qx = num(), qy = num(), ex = num(), ey = num(); return [x, y, x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]; })()
      : [x, y, num(), num(), num(), num(), num(), num()];
    // 取样点连成的小段一段段算（只看点会漏掉从两个点之间切过卡角的）
    let u = { x, y };
    for (let k = 1; k <= 16; k++) {
      const v = bezAt(c, k / 16);
      if (obs.some((b) => lineHits(u.x, u.y, v.x, v.y, b, e))) return true;
      u = v;
    }
    x = c[6]; y = c[7];
  }
  return false;
}

const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const BEND = 24;
/**
 * 绕开卡的横竖折线（不含两个端点的拐点）：从 p 沿它的方向出去、最后一段从卡外朝 q 的卡进来，不进任何一张卡。
 * 候选的横竖线 = 两个端点、每张卡外 clear、两张卡之间缝的正中（缝再小也走得过去）；在这张网格上找「长度 + 拐弯」最小的路。
 * 网格只有十来条线，每帧重算也很便宜。找不到（卡叠在端点上）返回 null
 */
function detour(p: Anchor, q: Anchor, obs: Box[], clear = CLEAR): Pt[] | null {
  const dp = axisOf(p), dq = axisOf(q);
  if (!dp || !dq) return null;
  const xs = [p.x, q.x], ys = [p.y, q.y];
  for (const b of obs) { xs.push(b.x - clear, b.x + b.w + clear); ys.push(b.y - clear, b.y + b.h + clear); }
  for (const a of obs) for (const b of obs) {
    if (a.x + a.w <= b.x) xs.push((a.x + a.w + b.x) / 2);
    if (a.y + a.h <= b.y) ys.push((a.y + a.h + b.y) / 2);
  }
  const X = [...new Set(xs)].sort((u, v) => u - v), Y = [...new Set(ys)].sort((u, v) => u - v);
  const nx = X.length, ny = Y.length, N = nx * ny * 4;
  const node = (i: number, j: number) => i * ny + j;
  const s0 = node(X.indexOf(p.x), Y.indexOf(p.y)), goal = node(X.indexOf(q.x), Y.indexOf(q.y));
  const dirOf = (d: Pt) => DIRS.findIndex((v) => v.x === d.x && v.y === d.y);
  const start = dirOf(dp), arrive = dirOf({ x: -dq.x, y: -dq.y });
  const cost = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  cost[s0 * 4 + start] = 0;
  // 状态 = (格点, 来的方向)；不到一百个格点，线性挑最小就够了
  for (;;) {
    let st = -1, best = Infinity;
    for (let k = 0; k < N; k++) if (!done[k] && cost[k] < best) { best = cost[k]; st = k; }
    if (st < 0) return null;
    const n = st >> 2, dir = st & 3;
    if (n === goal && dir === arrive) break;
    done[st] = 1;
    const i = Math.floor(n / ny), j = n % ny;
    for (let d = 0; d < 4; d++) {
      if (d === ((dir + 2) & 3) || (n === s0 && st === s0 * 4 + start && d !== start)) continue;
      const i2 = i + DIRS[d].x, j2 = j + DIRS[d].y;
      if (i2 < 0 || i2 >= nx || j2 < 0 || j2 >= ny) continue;
      if (obs.some((b) => lineHits(X[i], Y[j], X[i2], Y[j2], b, 0.5))) continue; // 贴着卡边走不算进
      const t = node(i2, j2) * 4 + d, c = best + Math.abs(X[i2] - X[i]) + Math.abs(Y[j2] - Y[j]) + (d === dir ? 0 : BEND);
      if (c < cost[t]) { cost[t] = c; from[t] = st; }
    }
  }
  // 倒着走回去，只留拐点
  const way: Pt[] = [];
  let st = goal * 4 + arrive;
  while (from[st] >= 0) {
    const prev = from[st];
    if ((prev & 3) !== (st & 3)) { const n = prev >> 2; way.unshift({ x: X[Math.floor(n / ny)], y: Y[n % ny] }); }
    st = prev;
  }
  return way.length ? way : [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }];
}

/** 曲线主题里绕开卡的折线：拐角倒成圆弧（二次贝塞尔），其余照直线 */
function rounded(p: Anchor, q: Anchor, way: Pt[]): Shape {
  const all = [{ x: p.x, y: p.y }, ...way, { x: q.x, y: q.y }];
  let d = `M${r(p.x)} ${r(p.y)}`;
  for (let i = 1; i < all.length - 1; i++) {
    const a = all[i - 1], c = all[i], b = all[i + 1];
    const la = Math.hypot(c.x - a.x, c.y - a.y), lb = Math.hypot(b.x - c.x, b.y - c.y);
    const k = Math.min(14, la / 2, lb / 2);
    const u = { x: c.x - ((c.x - a.x) / (la || 1)) * k, y: c.y - ((c.y - a.y) / (la || 1)) * k };
    const v = { x: c.x + ((b.x - c.x) / (lb || 1)) * k, y: c.y + ((b.y - c.y) / (lb || 1)) * k };
    d += ` L${r(u.x)} ${r(u.y)} Q${r(c.x)} ${r(c.y)} ${r(v.x)} ${r(v.y)}`;
  }
  d += ` L${r(q.x)} ${r(q.y)}`;
  const f = way[0], l = way[way.length - 1], mid = midOf(all);
  return {
    d, pts: [p.x, p.y, f.x, f.y, l.x, l.y, q.x, q.y], mx: mid.x, my: mid.y,
    inDir: unit(q.x - l.x, q.y - l.y, -q.nx, -q.ny), outDir: unit(p.x - f.x, p.y - f.y, -p.nx, -p.ny),
  };
}

/** 卡内自连：从这一侧绕一个弧回来 */
export function selfArc(p: Anchor, q: Anchor, route: "curve" | "elbow", clear = CLEAR): Shape {
  const k = clamp(Math.abs(q.y - p.y) * 0.5 + Math.abs(q.x - p.x) * 0.5, 28, 90);
  if (route === "elbow") {
    const xo = (p.nx > 0 ? Math.max(p.x, q.x) : Math.min(p.x, q.x)) + p.nx * clear;
    return {
      d: `M${r(p.x)} ${r(p.y)} L${r(xo)} ${r(p.y)} L${r(xo)} ${r(q.y)} L${r(q.x)} ${r(q.y)}`, pts: [p.x, p.y, xo, p.y, xo, q.y, q.x, q.y],
      mx: xo, my: (p.y + q.y) / 2, inDir: { x: -q.nx, y: -q.ny }, outDir: { x: -p.nx, y: -p.ny },
    };
  }
  const c1 = { x: p.x + p.nx * k, y: p.y }, c2 = { x: q.x + q.nx * k, y: q.y };
  return {
    d: `M${r(p.x)} ${r(p.y)} C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(q.x)} ${r(q.y)}`, pts: [p.x, p.y, c1.x, c1.y, c2.x, c2.y, q.x, q.y],
    mx: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, my: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8,
    inDir: unit(q.x - c2.x, q.y - c2.y, -q.nx, -q.ny), outDir: unit(p.x - c1.x, p.y - c1.y, -p.nx, -p.ny),
  };
}

/** Compare 两栏之间行对行：中缝里一条直的对照线，不带箭头 */
export function gutterLine(x: number, y1: number, y2: number, left: boolean): Shape {
  const g = 7, xa = left ? x - g : x + g, xb = left ? x + g : x - g;
  return {
    d: `M${r(xa)} ${r(y1)} L${r(xb)} ${r(y2)}`, pts: [xa, y1, xa + (xb - xa) / 3, y1 + (y2 - y1) / 3, xa + (2 * (xb - xa)) / 3, y1 + (2 * (y2 - y1)) / 3, xb, y2],
    mx: x, my: (y1 + y2) / 2, inDir: unit(xb - xa, y2 - y1, 1, 0), outDir: unit(xa - xb, y1 - y2, -1, 0),
  };
}

/** 箭头：tip 是尖，(ux, uy) 是来的方向（单位向量）。k = 形状（材质决定），s = 粗细档带来的放大 */
export function headPath(k: "chevron" | "triangle" | "dot", tx: number, ty: number, ux: number, uy: number, s = 1) {
  if (k === "dot") { const rr = 3.5 * s; return `M${r(tx - rr)} ${r(ty)} a${rr} ${rr} 0 1 0 ${2 * rr} 0 a${rr} ${rr} 0 1 0 ${-2 * rr} 0`; }
  const l = (k === "triangle" ? 8 : 7) * s, w = 4 * s;
  const a = `M${r(tx - l * ux - w * uy)} ${r(ty - l * uy + w * ux)} L${r(tx)} ${r(ty)} L${r(tx - l * ux + w * uy)} ${r(ty - l * uy - w * ux)}`;
  return k === "triangle" ? a + " Z" : a;
}
