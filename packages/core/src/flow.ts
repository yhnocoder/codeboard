// 箭头连成的图：讲解（Walkthrough）顺序、某张卡往下能走到哪些卡。都从 Link 现算，不另外存。
import type { Board, Card, Link } from "./model";

type G = Pick<Board, "cards" | "links">;

/** 箭头出发位置的排序键：整张卡出发的排最前；行出发的先按段在卡里的顺序，再按行号、调用所在列 */
function fromKey(byId: Map<string, Card>, l: Link): number {
  if (l.from.line === undefined) return -1;
  const c = byId.get(l.from.card);
  const si = c?.kind === "code" ? Math.max(0, c.segments.findIndex((s) => s.id === l.from.seg)) : 0;
  return si * 1e6 + l.from.line + (l.call?.col ?? 0) / 1000;
}

/** 从这张卡（或 Compare 的某一栏）连出去的箭头，按出发位置排好（同一位置按建的先后） */
export function outLinks(b: G, id: string): Link[] {
  const byId = new Map(b.cards.map((c) => [c.id, c]));
  const c = byId.get(id);
  const from = new Set(c?.kind === "compare" ? [id, ...c.cols] : [id]);
  const ls = b.links.filter((l) => from.has(l.from.card) && byId.has(l.to.card));
  return ls.map((l, i) => ({ l, i, k: fromKey(byId, l) })).sort((x, y) => x.k - y.k || x.i - y.i).map((x) => x.l);
}

/**
 * 讲解顺序（深度优先）：这张卡 → 卡本身连出去的 → 每一行连出去的（按行号）；
 * 每到一张卡都先把它自己的这一套走完再回来。走过的卡不再走（有环也不怕）。
 * 返回的是卡片 id（Compare 的栏会换成 Compare 本身）。
 */
export function walkOrder(b: G, start: string): string[] {
  const host = hostOf(b);
  const out: string[] = [];
  const seen = new Set<string>();
  const go = (id: string) => {
    const h = host.get(id) ?? id;
    if (seen.has(h)) return;
    seen.add(h);
    out.push(h);
    for (const l of outLinks(b, h)) go(l.to.card);
  };
  go(start);
  return out;
}

/** 从这张卡沿箭头往下能走到的所有卡（不含自己） */
export function reachable(b: G, id: string): string[] {
  return walkOrder(b, id).slice(1);
}

/** Compare 的栏 → Compare */
function hostOf(b: G): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) m.set(k, c.id);
  return m;
}
