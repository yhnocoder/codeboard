// 调用图：有 Call 标记的箭头连成的图（连通分量）。标记（字母 / 图标）、讲解顺序、折叠都从 Link 算出来，不另外存。
// 一张卡可以有好几条进来的 Call 箭头，图里可以有环；没有编号。
import { colHosts, type Board, type Card, type GraphMark, type Link } from "./model";

export type CallLink = Link & { call: NonNullable<Link["call"]> };
export const isCall = (l: Link): l is CallLink => !!l.call;

/** 一张调用图 */
export type Graph = {
  /** 图里最早建的卡（按 born）：用户改的标记存在它名下 */
  id: string;
  cards: string[];
  /** 没有进来的 Call 箭头的卡（整张图是一个环时，就是最早建的那张） */
  roots: string[];
  mark: GraphMark;
  /** 字母（自动分配的或用户选的）；用的是图标时为 "" */
  label: string;
  /** 用户改过标记 */
  custom: boolean;
};

export type Flows = {
  /** 按最早那张卡的创建顺序排 */
  graphs: Graph[];
  /** 卡片 id → 它所在的调用图（只有连着 Call 箭头的卡才有） */
  byId: Map<string, Graph>;
  /** 卡片 id → 从它出去的 Call 箭头，按出发位置排 */
  kids: Map<string, CallLink[]>;
  /** 卡片 id → 进来的 Call 箭头 */
  parents: Map<string, CallLink[]>;
};

type G = Pick<Board, "cards" | "links"> & Partial<Pick<Board, "born" | "marks">>;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const treeLetter = (i: number) => (i < 26 ? LETTERS[i] : LETTERS[Math.floor(i / 26) - 1] + LETTERS[i % 26]);

/** 创建顺序：born 里的号；还没编号的（刚建的、宿主写进来的）排在最后，按 cards 里的先后 */
export function bornRank(b: Pick<Board, "cards"> & Partial<Pick<Board, "born">>): (id: string) => number {
  const index = new Map<string, number>();
  b.cards.forEach((c, i) => index.set(c.id, i));
  return (id) => b.born?.[id] ?? 1e9 + (index.get(id) ?? 0);
}

/** Link 出发位置的排序键：整张卡出发的排最前；行出发的先按段在卡里的顺序，再按行号、调用所在列 */
function fromKey(byId: Map<string, Card>, l: Link): number {
  if (l.from.line === undefined) return -1;
  const c = byId.get(l.from.card);
  const si = c?.kind === "code" ? Math.max(0, c.segments.findIndex((s) => s.id === l.from.seg)) : 0;
  return si * 1e6 + l.from.line + (l.call?.col ?? 0) / 1000;
}
const sortFrom = <T extends Link>(byId: Map<string, Card>, ls: T[]) => ls.map((l, i) => ({ l, i, k: fromKey(byId, l) })).sort((x, y) => x.k - y.k || x.i - y.i).map((x) => x.l);

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

/**
 * 算出所有调用图。字母按图里最早建的卡的创建顺序 A、B…；用户改过标记的图用自己的（存在 marks 里，键是最早那张卡），
 * 自动分配的字母跳过用户占用的字母。两张图连到一起时，最早的卡在老的那张图里，所以沿用老图的标记。
 */
export function computeFlows(b: G): Flows {
  const cardsById = new Map(b.cards.map((c) => [c.id, c]));
  const calls = b.links.filter((l): l is CallLink => isCall(l) && cardsById.has(l.from.card) && cardsById.has(l.to.card) && l.from.card !== l.to.card);
  const up = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (up.get(r) !== r) r = up.get(r)!;
    while (x !== r) { const n = up.get(x)!; up.set(x, r); x = n; }
    return r;
  };
  const kids = new Map<string, CallLink[]>(), parents = new Map<string, CallLink[]>();
  for (const l of calls) {
    for (const id of [l.from.card, l.to.card]) if (!up.has(id)) up.set(id, id);
    const a = find(l.from.card), c = find(l.to.card);
    if (a !== c) up.set(a, c);
    push(kids, l.from.card, l);
    push(parents, l.to.card, l);
  }
  for (const [k, ls] of kids) kids.set(k, sortFrom(cardsById, ls));
  const rank = bornRank(b);
  const groups = new Map<string, string[]>();
  for (const id of up.keys()) push(groups, find(id), id);
  const raw = [...groups.values()].map((cards) => {
    cards.sort((x, y) => rank(x) - rank(y));
    const roots = cards.filter((id) => !parents.has(id));
    return { id: cards[0], cards, roots: roots.length ? roots : [cards[0]] };
  }).sort((x, y) => rank(x.id) - rank(y.id));
  const taken = new Set<string>();
  for (const g of raw) { const m = b.marks?.[g.id]; if (m && "letter" in m) taken.add(m.letter); }
  let i = 0;
  const graphs: Graph[] = raw.map((g) => {
    const m = b.marks?.[g.id];
    if (m) return { ...g, mark: m, label: "letter" in m ? m.letter : "", custom: true };
    while (taken.has(treeLetter(i))) i++;
    const letter = treeLetter(i++);
    return { ...g, mark: { letter }, label: letter, custom: false };
  });
  const byId = new Map<string, Graph>();
  for (const g of graphs) for (const id of g.cards) byId.set(id, g);
  return { graphs, byId, kids, parents };
}

/** 从这张卡沿 Call 箭头往下能走到的卡（不含自己；有环也不怕） */
export function descendants(f: Flows, id: string): string[] {
  const seen = new Set([id]);
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const x = stack.pop()!;
    for (const l of f.kids.get(x) ?? []) if (!seen.has(l.to.card)) { seen.add(l.to.card); out.push(l.to.card); stack.push(l.to.card); }
  }
  return out;
}

/** 从这张卡（Compare：连同两栏）出去的箭头，按出发位置排 */
function outLinks(b: Pick<Board, "links">, byId: Map<string, Card>, id: string): Link[] {
  const c = byId.get(id);
  const from = c?.kind === "compare" ? [id, ...c.cols] : [id];
  const out: Link[] = [];
  for (const k of from) out.push(...sortFrom(byId, b.links.filter((l) => l.from.card === k && byId.has(l.to.card))));
  return out;
}

/**
 * 讲解顺序：从 start 出发，先沿 Call 箭头深度优先走到底（按出发行的先后），
 * 再从走过的卡依次走普通箭头（到了新卡又先走它的 Call 箭头）。走过的卡不再走（有环也不怕；Compare 和它的栏算一张）。
 */
export function walkOrder(b: Pick<Board, "cards" | "links">, start: string): string[] {
  const byId = new Map(b.cards.map((c) => [c.id, c]));
  const host = colHosts(b);
  const out: string[] = [];
  const seen = new Set<string>();
  const calls = (id: string) => {
    const k = host.get(id) ?? id;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(id);
    for (const l of outLinks(b, byId, id)) if (l.call) calls(l.to.card);
  };
  calls(start);
  for (let i = 0; i < out.length; i++) for (const l of outLinks(b, byId, out[i])) if (!l.call) calls(l.to.card);
  return out;
}

/**
 * 因为折叠而看不见的卡：从图的根出发沿 Call 箭头走，折叠了的卡不再往下走；走不到的藏起来。
 * 也就是说，一张卡只有在每条从根进来的 Call 路径都经过折叠的卡时才藏起来。
 */
export function hiddenByCollapse(b: Pick<Board, "cards" | "place">, f: Flows): Set<string> {
  const host = colHosts(b);
  const collapsed = (id: string) => !!b.place[host.get(id) ?? id]?.collapsed;
  const hidden = new Set<string>();
  for (const g of f.graphs) {
    if (!g.cards.some(collapsed)) continue;
    const seen = new Set<string>(g.roots);
    const stack = [...g.roots];
    while (stack.length) {
      const x = stack.pop()!;
      if (collapsed(x)) continue;
      for (const l of f.kids.get(x) ?? []) if (!seen.has(l.to.card)) { seen.add(l.to.card); stack.push(l.to.card); }
    }
    for (const id of g.cards) if (!seen.has(id)) hidden.add(id);
  }
  return hidden;
}
