// Tidy Up 的排版。ELK 有 1.6 MB，只在宿主里跑（@codeboard/core/tidy），不进 webview；第一次 Tidy Up 时才加载
import type ELK from "elkjs/lib/elk.bundled.js";
import { bounds, overlaps, GAP, type Rect } from "./layout";

/** Tidy Up 里列与列之间的空（留给箭头） */
export const TIDY_COL_GAP = 2 * GAP;

type R = Rect & { id: string };
type At = Map<string, { x: number; y: number }>;

let elk: InstanceType<typeof ELK> | undefined;

/**
 * 整理选中的卡：有箭头连着的交给 ELK 的分层布局（从左往右按调用深度分列，减少箭头交叉，环自动断开；
 * 同一列里尽量保持现在从上到下的顺序，几组互不相连的上下排开）；
 * 没有箭头连着的，按现在的 y 分成几行（每行按 x 排、顶端对齐）放在箭头那组下面。
 * 从这些卡现在的左上角开始摆。fixed = 不能动的卡（锁住的）：压到它的卡往下（行里往右）挪开，后面的卡跟着让。
 * 返回每张卡的新 x / y
 */
export async function tidy(rs: R[], links: [string, string][], fixed: Rect[] = []): Promise<At> {
  const out: At = new Map();
  const b = bounds(rs);
  if (!b) return out;
  const byId = new Map(rs.map((r) => [r.id, r]));
  const edges = links.filter(([f, t]) => f !== t && byId.has(f) && byId.has(t));
  const ends = new Set(edges.flat());
  const linked = rs.filter((r) => ends.has(r.id));
  const rest = rs.filter((r) => !ends.has(r.id));
  const placed: Rect[] = [];
  let top = b.y;
  if (linked.length) {
    const flow = await layered(linked, edges);
    // 先放上面的：被锁住的卡压到就往下挪，再压到已经放好的也往下，所以一列里后面的卡会跟着让
    for (const r of [...linked].sort((p, q) => flow.get(p.id)!.y - flow.get(q.id)!.y || flow.get(p.id)!.x - flow.get(q.id)!.x)) {
      const f = flow.get(r.id)!;
      const p = clear({ x: b.x + f.x, y: b.y + f.y, w: r.w, h: r.h }, fixed, placed, false);
      out.set(r.id, p);
      placed.push({ ...p, w: r.w, h: r.h });
    }
    top = Math.max(...placed.map((p) => p.y + p.h)) + TIDY_COL_GAP;
  }
  // 行：按 y 排，一张卡的顶端落在这一行的上四分之三里就算同一行
  const rows: { top: number; h: number; rs: R[] }[] = [];
  for (const r of [...rest].sort((p, q) => p.y - q.y || p.x - q.x)) {
    const last = rows[rows.length - 1];
    if (last && r.y < last.top + last.h * 0.75) { last.rs.push(r); last.h = Math.max(last.h, r.y + r.h - last.top); }
    else rows.push({ top: r.y, h: r.h, rs: [r] });
  }
  let y = top;
  for (const row of rows) {
    let x = b.x, bottom = y;
    for (const r of row.rs.sort((p, q) => p.x - q.x || p.y - q.y)) {
      const p = clear({ x, y, w: r.w, h: r.h }, fixed, placed, true);
      out.set(r.id, p);
      placed.push({ ...p, w: r.w, h: r.h });
      x = p.x + r.w + GAP;
      bottom = Math.max(bottom, p.y + r.h);
    }
    y = bottom + GAP;
  }
  return out;
}

/** 和锁住的卡或已经放好的卡重叠就顺着排列方向（列往下、行往右）跳过去，直到不重叠 */
function clear(r: Rect, fixed: Rect[], placed: Rect[], alongX: boolean): { x: number; y: number } {
  let { x, y } = r;
  const all = [...fixed, ...placed];
  for (let moved = true, n = 0; moved && n <= all.length; n++) {
    moved = false;
    for (const o of all) {
      if (!overlaps({ x, y, w: r.w, h: r.h }, o, GAP - 1)) continue;
      if (alongX) x = o.x + o.w + GAP; else y = o.y + o.h + GAP;
      moved = true;
    }
  }
  return { x, y };
}

/** ELK 分层布局，结果的左上角在 (0, 0)。卡按现在的 y（再按 x）给 ELK，它在不增加交叉的前提下保持这个顺序 */
async function layered(rs: R[], edges: [string, string][]): Promise<At> {
  elk ??= new (await import("elkjs/lib/elk.bundled.js")).default();
  const order = [...rs].sort((p, q) => p.y - q.y || p.x - q.x);
  const rank = new Map(order.map((r, i) => [r.id, i]));
  const sorted = [...edges].sort(([f1, t1], [f2, t2]) => rank.get(f1)! - rank.get(f2)! || rank.get(t1)! - rank.get(t2)!);
  const g = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": String(GAP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(TIDY_COL_GAP),
      "elk.spacing.componentComponent": String(TIDY_COL_GAP),
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.cycleBreaking.strategy": "GREEDY_MODEL_ORDER",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: order.map((r) => ({ id: r.id, width: r.w, height: r.h })),
    edges: sorted.map(([f, t], i) => ({ id: `e${i}`, sources: [f], targets: [t] })),
  });
  const at: At = new Map();
  for (const c of g.children ?? []) at.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const x0 = Math.min(...[...at.values()].map((p) => p.x)), y0 = Math.min(...[...at.values()].map((p) => p.y));
  for (const [id, p] of at) at.set(id, { x: Math.round(p.x - x0), y: Math.round(p.y - y0) });
  return at;
}
