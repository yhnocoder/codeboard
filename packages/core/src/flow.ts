// Call 流程：一棵由 Call link 组成的树。编号、顺序、能不能接上，都从 Link 算出来，不另外存。
import { findCard, type Board, type CodeCard, type Link } from "./model";

export type FlowNode = { id: string; link?: Link; kids: FlowNode[]; num: string; label: string; depth: number; tree: string };
export type Flows = {
  roots: FlowNode[];
  /** 卡片 id → 节点（只有在某棵树里的卡才有） */
  byId: Map<string, FlowNode>;
  /** 卡片 id → 父卡 id */
  parent: Map<string, string>;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const treeLetter = (i: number) => (i < 26 ? LETTERS[i] : LETTERS[Math.floor(i / 26) - 1] + LETTERS[i % 26]);

/** Link 出发位置的排序键：先按段在卡里的顺序，再按行号 */
function fromKey(b: Pick<Board, "cards">, l: Link): number {
  const c = findCard(b, l.from.card)?.card;
  if (c?.kind !== "code") return 0;
  const si = Math.max(0, c.segments.findIndex((s) => s.id === l.from.seg));
  return si * 1e6 + (l.from.line ?? 0) + (l.call?.col ?? 0) / 1000;
}

/**
 * 算出所有 Call 树。根卡是 A、B…；子卡在父卡下按出发行排，编号 1、2、2.1；
 * 多于一棵树时子卡带前缀 A·2.1。一张卡最多一条进来的 Call link。
 */
export function computeFlows(b: Pick<Board, "cards" | "links">): Flows {
  const calls = b.links.filter((l) => l.kind === "call" && findCard(b, l.from.card) && findCard(b, l.to.card));
  const parent = new Map<string, string>();
  const inLink = new Map<string, Link>();
  for (const l of calls) {
    if (inLink.has(l.to.card) || l.to.card === l.from.card) continue; // 只认第一条
    inLink.set(l.to.card, l);
    parent.set(l.to.card, l.from.card);
  }
  const out = new Map<string, Link[]>();
  for (const l of inLink.values()) {
    const arr = out.get(l.from.card) ?? [];
    arr.push(l);
    out.set(l.from.card, arr);
  }
  for (const arr of out.values()) arr.sort((x, y) => fromKey(b, x) - fromKey(b, y));

  // 根：有出去的 Call link，自己没有进来的。按卡片在白板里的先后（创建顺序）排字母
  const order = new Map<string, number>();
  let k = 0;
  for (const c of b.cards) {
    order.set(c.id, k++);
    if (c.kind === "compare") for (const col of c.cols) order.set(col.id, k++);
  }
  const rootIds = [...out.keys()].filter((id) => !parent.has(id)).sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0));
  const multi = rootIds.length > 1;
  const byId = new Map<string, FlowNode>();
  const roots: FlowNode[] = [];
  rootIds.forEach((rid, i) => {
    const letter = treeLetter(i);
    const build = (id: string, num: string, depth: number, link: Link | undefined, seen: Set<string>): FlowNode => {
      const node: FlowNode = { id, link, kids: [], num, depth, tree: rid, label: depth === 0 ? letter : multi ? `${letter}·${num}` : num };
      byId.set(id, node);
      seen.add(id);
      let n = 0;
      for (const l of out.get(id) ?? []) {
        if (seen.has(l.to.card)) continue;
        n++;
        node.kids.push(build(l.to.card, depth === 0 ? `${n}` : `${num}.${n}`, depth + 1, l, seen));
      }
      return node;
    };
    roots.push(build(rid, "", 0, undefined, new Set()));
  });
  return { roots, byId, parent };
}

/** 讲解顺序：A → 1 → 1.1 → 2 …（先序） */
export function walkOrder(root: FlowNode): FlowNode[] {
  const out: FlowNode[] = [];
  const go = (n: FlowNode) => { out.push(n); n.kids.forEach(go); };
  go(root);
  return out;
}

/** 某张卡所在的树的根节点 */
export function treeOf(f: Flows, id: string): FlowNode | undefined {
  const n = f.byId.get(id);
  return n && f.byId.get(n.tree);
}

/** 子树里所有卡（不含自己） */
export function descendants(n: FlowNode): string[] {
  const out: string[] = [];
  const go = (x: FlowNode) => x.kids.forEach((k) => { out.push(k.id); go(k); });
  go(n);
  return out;
}

/** 因为祖先折叠而看不见的卡 */
export function hiddenByCollapse(b: Pick<Board, "cards">, f: Flows): Set<string> {
  const hidden = new Set<string>();
  const collapsed = (id: string) => (findCard(b, id)?.host as CodeCard | undefined)?.collapsed;
  for (const r of f.roots) {
    const go = (n: FlowNode, under: boolean) => {
      if (under) hidden.add(n.id);
      n.kids.forEach((k) => go(k, under || !!collapsed(n.id)));
    };
    go(r, false);
  }
  return hidden;
}

/**
 * 把一个调用接到已有的卡上：目标卡必须还不在任何流程里（没有编号），
 * 也不能是出发卡自己。在流程里的卡要先 Duplicate。
 */
export function canAttach(f: Flows, fromCard: string, target: string): { ok: true } | { ok: false; reason: string } {
  if (fromCard === target) return { ok: false, reason: "Can't link a card to itself." };
  if (f.byId.has(target)) return { ok: false, reason: "Already in a flow. Duplicate it first." };
  return { ok: true };
}

/** Compare：两张卡不能分属两棵不同的树 */
export function canCompare(f: Flows, a: string, b: string): { ok: true } | { ok: false; reason: string } {
  const ta = f.byId.get(a)?.tree, tb = f.byId.get(b)?.tree;
  if (ta && tb && ta !== tb) return { ok: false, reason: "These cards are in different flows. Duplicate one first." };
  return { ok: true };
}
