// 箭头走线的纯计算（不碰 DOM、不读 store）：两端走哪一侧（W03 1–4，带缓冲）、端点和朝向、曲线 / 直角折线、错位时斜着进（W03 11）。
// Links.tsx 每条线一个 memo 调这里；单元测试在 test/unit/route.test.ts。

export type Side = "left" | "right" | "top" | "bottom";
export type Box = { x: number; y: number; w: number; h: number };
/**
 * 两张卡的摆法（从起点看）：sepR / sepL = 左右分开（终点在右 / 在左）；stackR / stackL = 上下摆放、有一端是行，C 形走右 / 左；
 * down / up = 上下摆放、两端都是卡，终点在下 / 在上
 */
export type Mode = "sepR" | "sepL" | "stackR" | "stackL" | "down" | "up";
export type Pt = { x: number; y: number };
/** 端点：位置 + 朝卡外的方向（单位向量） */
export type Anchor = { x: number; y: number; nx: number; ny: number };

/**
 * 直角折线绕到卡外面时，竖（横）的那段离卡边多远。默认 24；City 的路有 16px 宽的路沿，
 * 材质给更大的值（shape().clear），路和卡边之间留出一条路宽，汇在一起的主干不贴着卡走
 */
export const CLEAR = 24;

const cx = (b: Box) => b.x + b.w / 2, cy = (b: Box) => b.y + b.h / 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * W03 1–4 + 5：按两张卡的左右关系定摆法。H = 换边缓冲：从「上下」换成「左右分开」要拉开 H，分开以后要重叠才换回来；
 * C 形的左右、卡↔卡的上下也要越过 H 才换（来回拖不抖）。prev = 这条线上一次的结果（没有 = 第一次画）
 */
export function chooseMode(a: Box, b: Box, cards: boolean, prev: Mode | undefined, H: number): Mode {
  const gapR = b.x - (a.x + a.w), gapL = a.x - (b.x + b.w);
  if (gapR >= (prev === "sepR" ? 0 : H)) return "sepR";
  if (gapL >= (prev === "sepL" ? 0 : H)) return "sepL";
  if (cards) {
    const d = cy(b) - cy(a);
    if (prev === "down" && d > -H) return "down";
    if (prev === "up" && d < H) return "up";
    return d >= 0 ? "down" : "up";
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

export const normalOf = (s: Side): Pt => (s === "left" ? { x: -1, y: 0 } : s === "right" ? { x: 1, y: 0 } : s === "top" ? { x: 0, y: -1 } : { x: 0, y: 1 });

/** 端点：行端在那一行的左 / 右边；卡端在左右边时落在卡头那一行（rowY），上下边时在边的正中 */
export function anchorOn(b: Box, side: Side, rowY: number): Anchor {
  const n = normalOf(side);
  if (side === "left") return { x: b.x, y: rowY, nx: n.x, ny: n.y };
  if (side === "right") return { x: b.x + b.w, y: rowY, nx: n.x, ny: n.y };
  if (side === "top") return { x: cx(b), y: b.y, nx: n.x, ny: n.y };
  return { x: cx(b), y: b.y + b.h, nx: n.x, ny: n.y };
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
 * W03 11：终点正前方空间不够、侧向又偏得多时，方向朝对面那一端斜过去，最多 45°（不先拐直角再进）。
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
  const dot = p.nx * q.nx + p.ny * q.ny;
  // 同一侧、但起点在终点卡的里侧（或反过来），直着绕会穿过那张卡：从卡的下面 / 上面绕过去（W01 E3 Compare 交换后从右边进）
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
  const all = [{ x: p.x, y: p.y }, ...way, { x: q.x, y: q.y }];
  const d = "M" + all.map((v) => `${r(v.x)} ${r(v.y)}`).join(" L");
  const a = way[0], b = way[way.length - 1];
  const mid = way.length === 2 ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
  return {
    d, pts: [p.x, p.y, a.x, a.y, b.x, b.y, q.x, q.y], mx: mid.x, my: mid.y,
    inDir: unit(q.x - b.x, q.y - b.y, -q.nx, -q.ny), outDir: unit(p.x - a.x, p.y - a.y, -p.nx, -p.ny),
  };
}

/** 卡内自连（W01 4）：从这一侧绕一个弧回来 */
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

/** Compare 两栏之间行对行（W01 11）：中缝里一条直的对照线，不带箭头 */
export function gutterLine(x: number, y1: number, y2: number, left: boolean): Shape {
  const g = 7, xa = left ? x - g : x + g, xb = left ? x + g : x - g;
  return {
    d: `M${r(xa)} ${r(y1)} L${r(xb)} ${r(y2)}`, pts: [xa, y1, xa + (xb - xa) / 3, y1 + (y2 - y1) / 3, xa + (2 * (xb - xa)) / 3, y1 + (2 * (y2 - y1)) / 3, xb, y2],
    mx: x, my: (y1 + y2) / 2, inDir: unit(xb - xa, y2 - y1, 1, 0), outDir: unit(xa - xb, y1 - y2, -1, 0),
  };
}

/** City：停在路尽头的小车的 transform（carPaths 按它画）。车头在原点朝 +x，tip 是车头，(ux, uy) 是开过来的方向 */
export function carAt(tx: number, ty: number, ux: number, uy: number, s = 1) {
  return `translate(${r(tx - ux)} ${r(ty - uy)}) rotate(${r((Math.atan2(uy, ux) * 180) / Math.PI)})${s !== 1 ? ` scale(${s})` : ""}`;
}
/**
 * City：把 carAt 的 transform 直接画进三条 path（车身、车顶、两个车灯），世界坐标。拖动时每帧要重画整层线，
 * 每辆车带一个 transform 会多出一个绘制块，两百辆车就让 Layerize / Paint 每帧多 3 ms 左右；烤进坐标就没有这笔开销
 */
export function carPaths(at: string, road?: Road) {
  const n = at.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
  const [tx = 0, ty = 0, deg = 0, s = 1] = n, a = (deg * Math.PI) / 180, c = Math.cos(a) * s, sn = Math.sin(a) * s;
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

/** 箭头：tip 是尖，(ux, uy) 是来的方向（单位向量）。k = 形状（材质决定），s = 粗细档带来的放大 */
export function headPath(k: "chevron" | "triangle" | "dot", tx: number, ty: number, ux: number, uy: number, s = 1) {
  if (k === "dot") { const rr = 3.5 * s; return `M${r(tx - rr)} ${r(ty)} a${rr} ${rr} 0 1 0 ${2 * rr} 0 a${rr} ${rr} 0 1 0 ${-2 * rr} 0`; }
  const l = (k === "triangle" ? 8 : 7) * s, w = 4 * s;
  const a = `M${r(tx - l * ux - w * uy)} ${r(ty - l * uy + w * ux)} L${r(tx)} ${r(ty)} L${r(tx - l * ux + w * uy)} ${r(ty - l * uy - w * ux)}`;
  return k === "triangle" ? a + " Z" : a;
}
