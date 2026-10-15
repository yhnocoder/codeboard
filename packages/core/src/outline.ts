import type { Board, Card, CodeCard } from "./model";

export type OutlineNode = { card: CodeCard; kids: OutlineNode[] };

/** 按箭头关系把代码卡片排成树：没有入边的是根，子节点按出发行号排序 */
export function outlineTree(b: Pick<Board, "cards" | "edges">): OutlineNode[] {
  const code = b.cards.filter((c): c is CodeCard => c.type === "code");
  const ids = new Set(code.map((c) => c.id));
  const incoming = new Set(b.edges.filter((e) => ids.has(e.from.card) && ids.has(e.to.card)).map((e) => e.to.card));
  const seen = new Set<string>();
  const build = (c: CodeCard): OutlineNode => {
    seen.add(c.id);
    const next = b.edges
      .filter((e) => e.from.card === c.id && ids.has(e.to.card))
      .sort((x, y) => (x.from.line ?? 0) - (y.from.line ?? 0))
      .map((e) => code.find((k) => k.id === e.to.card)!);
    const kids: OutlineNode[] = [];
    for (const k of next) if (!seen.has(k.id)) kids.push(build(k));
    return { card: c, kids };
  };
  const roots: OutlineNode[] = [];
  for (const c of sortByStep(code.filter((c) => !incoming.has(c.id)))) if (!seen.has(c.id)) roots.push(build(c));
  for (const c of code) if (!seen.has(c.id)) roots.push(build(c));
  return roots;
}

const stepKey = (s: string) => s.split(".").map((n) => n.padStart(4, "0")).join(".");

export function sortByStep<T extends Card>(cards: T[]): T[] {
  return [...cards].sort((a, b) => {
    const sa = a.type === "code" ? a.step : undefined, sb = b.type === "code" ? b.step : undefined;
    if (sa && sb) return stepKey(sa).localeCompare(stepKey(sb));
    return sa ? -1 : sb ? 1 : 0;
  });
}

/** 讲解顺序：有编号的代码卡片按编号排序 */
export function steps(b: Pick<Board, "cards">): CodeCard[] {
  return sortByStep(b.cards.filter((c): c is CodeCard => c.type === "code" && !!c.step));
}

export function cardTitle(c: CodeCard): string {
  return c.title ?? c.symbol ?? `${c.path.split("/").pop()}:${c.start}`;
}
