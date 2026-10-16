// 摆放：新卡放哪、展开出来的子卡放哪、Tidy Layout。只做几何，尺寸由调用方给（白板里是实测尺寸）。
import type { FlowNode } from "./flow";
import type { Card, Place } from "./model";

export type Rect = { x: number; y: number; w: number; h: number };

export const GAP = 28; // 卡片之间留的空
export const INDENT = 56; // 子卡相对父卡的缩进
export const SIB_GAP = 24;

/** 还没渲染、量不到实测尺寸时的估计（白板放新卡、宿主在白板没开时直接写卡都用它） */
export function estSize(c: Card, p: Pick<Place, "w" | "h"> = { w: defaultWidth(c) }): { w: number; h: number } {
  if (p.h) return { w: p.w, h: p.h };
  if (c.kind === "links") return { w: p.w, h: 52 + c.items.length * (c.rich ? 72 : 30) };
  if (c.kind !== "code") return { w: p.w, h: c.kind === "web" ? 112 : 160 };
  const lines = c.segments.reduce((n, s) => n + s.end - s.start + 1, 0);
  return { w: p.w, h: Math.min(520, 52 + lines * 19) };
}

/** 新卡的默认宽度（代码卡按最长的行估） */
export function defaultWidth(c: Card): number {
  switch (c.kind) {
    case "code": {
      const longest = Math.max(20, ...c.segments.flatMap((s) => s.text.map((l) => l.replace(/\t/g, "    ").length)));
      return Math.round(Math.min(760, Math.max(380, longest * 7.4 + 70)));
    }
    case "note": return c.bg ? 280 : 320;
    case "image": return 320;
    case "web": return 420;
    case "links": return 380;
    case "compare": return 900;
  }
}

export function overlaps(a: Rect, b: Rect, gap = 0) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
export const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
export const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function bounds(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 从 (x, y) 附近找一块不和别的卡重叠的地方：先往下，再往右，螺旋式扩大 */
export function findFree(want: Rect, others: Rect[], gap = GAP): { x: number; y: number } {
  const free = (x: number, y: number) => !others.some((o) => overlaps({ x, y, w: want.w, h: want.h }, o, gap));
  if (free(want.x, want.y)) return { x: want.x, y: want.y };
  const step = 40;
  for (let r = 1; r < 60; r++) {
    const cands: [number, number][] = [
      [want.x, want.y + r * step],
      [want.x + r * step, want.y],
      [want.x + r * step, want.y + r * step],
      [want.x, want.y - r * step],
      [want.x - r * step, want.y],
    ];
    for (const [x, y] of cands) if (free(x, y)) return { x, y };
  }
  return { x: want.x, y: want.y + 60 * step };
}

/** 选中卡片旁边的空位：先右边，再下边 */
export function besideFree(sel: Rect, size: { w: number; h: number }, others: Rect[]): { x: number; y: number } {
  const right = { x: sel.x + sel.w + GAP * 2, y: sel.y, ...size };
  if (!others.some((o) => overlaps(right, o, GAP))) return right;
  const below = { x: sel.x, y: sel.y + sel.h + GAP * 2, ...size };
  if (!others.some((o) => overlaps(below, o, GAP))) return below;
  return findFree(right, others);
}

/**
 * 展开出来的子卡：down = 缩进放在父卡下方；right = 放在父卡右边、和出发行齐平。按出发行号从上到下。
 * before = 出发行在它前面的兄弟（及其子树）的矩形；新卡放在它们下面。
 */
export function placeChild(parent: Rect, size: { w: number; h: number }, before: Rect[], others: Rect[], dir: TidyDir = "down", lineY?: number): { x: number; y: number } {
  let x = parent.x + INDENT;
  let y = parent.y + parent.h + GAP;
  if (dir === "right") { x = parent.x + parent.w + GAP * 2; y = Math.max(parent.y, (lineY ?? parent.y + 20) - 20); }
  for (const s of before) y = Math.max(y, s.y + s.h + SIB_GAP);
  return findFreeDown({ x, y, ...size }, others);
}

function findFreeDown(want: Rect, others: Rect[]) {
  let y = want.y;
  for (let i = 0; i < 400; i++) {
    const r = { ...want, y };
    const hit = others.filter((o) => overlaps(r, o, SIB_GAP / 2));
    if (!hit.length) return { x: want.x, y };
    y = Math.max(...hit.map((o) => o.y + o.h)) + SIB_GAP;
  }
  return { x: want.x, y };
}

/**
 * 视野里离 want 最近的空位（网格 40 步）。卡太高时只要求上面 minVis 露在视野里。没有就返回 null。
 */
export function freeInView(want: Rect, others: Rect[], view: Rect, minVis = 200, gap = GAP): { x: number; y: number } | null {
  const step = 40, vh = Math.min(want.h, minVis);
  const x1 = view.x + view.w - Math.min(want.w, view.w), y1 = view.y + view.h - vh;
  let best: { x: number; y: number } | null = null, bd = Infinity;
  for (let y = view.y; y <= y1; y += step) for (let x = view.x; x <= x1; x += step) {
    const d = Math.hypot(x - want.x, y - want.y);
    if (d >= bd) continue;
    if (others.some((o) => overlaps({ x, y, w: want.w, h: want.h }, o, gap))) continue;
    best = { x, y }; bd = d;
  }
  return best;
}

export type TidyDir = "down" | "right";


// ---------- 吸附 ----------

export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };

/**
 * 拖动吸附：moving 的左 / 中 / 右（上 / 中 / 下）对齐到别的矩形的同类边，阈值内就吸过去。
 * 返回修正量和要画的参考线。
 */
export function snapMove(moving: Rect, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  let bx: { d: number; at: number } | null = null, by: { d: number; at: number } | null = null;
  for (const o of others) {
    for (const a of xs(moving)) for (const b of xs(o)) { const d = b - a; if (Math.abs(d) <= threshold && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: b }; }
    for (const a of ys(moving)) for (const b of ys(o)) { const d = b - a; if (Math.abs(d) <= threshold && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: b }; }
  }
  const dx = bx?.d ?? 0, dy = by?.d ?? 0;
  const m = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  if (bx) {
    const hits = others.filter((o) => xs(o).some((v) => Math.abs(v - bx!.at) < 0.5));
    const ys0 = [m.y, m.y + m.h, ...hits.flatMap((o) => [o.y, o.y + o.h])];
    guides.push({ axis: "x", at: bx.at, from: Math.min(...ys0), to: Math.max(...ys0) });
  }
  if (by) {
    const hits = others.filter((o) => ys(o).some((v) => Math.abs(v - by!.at) < 0.5));
    const xs0 = [m.x, m.x + m.w, ...hits.flatMap((o) => [o.x, o.x + o.w])];
    guides.push({ axis: "y", at: by.at, from: Math.min(...xs0), to: Math.max(...xs0) });
  }
  return { dx, dy, guides };
}

/** 改大小吸附：拖的那条边吸到别的卡的边；和别的卡同宽 / 同高时吸住 */
export function snapResize(r: Rect, edges: { right?: boolean; bottom?: boolean }, others: Rect[], threshold: number): { w: number; h: number; guides: Guide[]; same?: "w" | "h" } {
  let w = r.w, h = r.h, same: "w" | "h" | undefined;
  const guides: Guide[] = [];
  if (edges.right) {
    let best: { d: number; at: number; same?: boolean } | null = null;
    for (const o of others) {
      for (const v of [o.x, o.x + o.w]) { const d = v - (r.x + r.w); if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: v }; }
      const d = o.w - r.w;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: r.x + o.w, same: true };
    }
    if (best) { w = r.w + best.d; guides.push({ axis: "x", at: r.x + w, from: r.y, to: r.y + h }); if (best.same) same = "w"; }
  }
  if (edges.bottom) {
    let best: { d: number; at: number; same?: boolean } | null = null;
    for (const o of others) {
      for (const v of [o.y, o.y + o.h]) { const d = v - (r.y + r.h); if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: v }; }
      const d = o.h - r.h;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: r.y + o.h, same: true };
    }
    if (best) { h = r.h + best.d; guides.push({ axis: "y", at: r.y + h, from: r.x, to: r.x + w }); if (best.same) same = same ?? "h"; }
  }
  return { w, h, guides, same };
}

// ---------- 对齐工具条 ----------

export type AlignOp = "left" | "hcenter" | "right" | "top" | "bottom" | "hdist" | "vdist";

/** 返回每个矩形的新 x / y */
export function align(rs: (Rect & { id: string })[], op: AlignOp): Map<string, Partial<Rect>> {
  const out = new Map<string, Partial<Rect>>();
  if (rs.length < 2) return out;
  const b = bounds(rs)!;
  switch (op) {
    case "left": rs.forEach((r) => out.set(r.id, { x: b.x })); break;
    case "right": rs.forEach((r) => out.set(r.id, { x: b.x + b.w - r.w })); break;
    case "hcenter": rs.forEach((r) => out.set(r.id, { x: b.x + b.w / 2 - r.w / 2 })); break;
    case "top": rs.forEach((r) => out.set(r.id, { y: b.y })); break;
    case "bottom": rs.forEach((r) => out.set(r.id, { y: b.y + b.h - r.h })); break;
    case "hdist": {
      const s = [...rs].sort((a, c) => a.x - c.x);
      const total = s.reduce((n, r) => n + r.w, 0);
      const gap = (b.w - total) / (s.length - 1);
      let x = b.x;
      for (const r of s) { out.set(r.id, { x }); x += r.w + gap; }
      break;
    }
    case "vdist": {
      const s = [...rs].sort((a, c) => a.y - c.y);
      const total = s.reduce((n, r) => n + r.h, 0);
      const gap = (b.h - total) / (s.length - 1);
      let y = b.y;
      for (const r of s) { out.set(r.id, { y }); y += r.h + gap; }
      break;
    }
  }
  return out;
}
