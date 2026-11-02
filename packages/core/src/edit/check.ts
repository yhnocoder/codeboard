// The board's self-check: references to things that are not there (always empty after an edit)
import { activeOf, twinContent, UPSTREAM, type Board, type CodeCard, type Sticker } from "../model";

/**
 * 白板里指向不存在的东西的引用（应该永远是空的）：Link 两端、Sidenote、Sticker、问题的解答、Compare 的栏、Place、Section 父子，以及重复的 id。
 * 给测试和 mutate 的自检用；返回每一处问题的说明。
 */
export function danglingRefs(b: Board): string[] {
  const out: string[] = [];
  const cards = new Map<string, Board["cards"][number]>();
  for (const c of b.cards) {
    if (cards.has(c.id)) out.push(`duplicate card id ${c.id}`);
    cards.set(c.id, c);
  }
  const links = new Set(b.links.map((l) => l.id));
  const sections = new Set(b.sections.map((s) => s.id));
  const segOk = (card: string, seg?: string) => {
    const c = cards.get(card);
    if (!c) return false;
    return !seg || (c.kind === "code" && c.segments.some((s) => s.id === seg));
  };
  for (const l of b.links)
    for (const e of [l.from, l.to])
      if (!segOk(e.card, e.seg)) out.push(`link ${l.id} → missing ${e.card}${e.seg ? `/${e.seg}` : ""}`);
  // Note 的块：只能在 Note 上，和行不能同时有；块还在不在由白板拆 Markdown 时看（blockAt 找不到就画在卡头）
  for (const l of b.links)
    for (const e of [l.from, l.to]) {
      if (!e.block) continue;
      const c = cards.get(e.card);
      if (c && c.kind !== "note") out.push(`link ${l.id} → block on ${e.card}, which is not a Note`);
      if (e.seg !== undefined || e.line !== undefined) out.push(`link ${l.id} → both a block and a line on ${e.card}`);
      if (!Number.isInteger(e.block.i) || e.block.i < 0 || !e.block.h)
        out.push(`link ${l.id} → bad block ${JSON.stringify(e.block)} on ${e.card}`);
    }
  // 标记的组合（LinkMarks）：类型挡住了写法，这里挡住从别处来的数据
  for (const l of b.links as { id: string; gen?: true; call?: unknown; rpc?: unknown; back?: true }[]) {
    const extra = (["call", "rpc", "back"] as const).filter((k) => l[k]);
    if (l.gen && extra.length) out.push(`generated-from link ${l.id} also has ${extra.join(", ")}`);
  }
  for (const n of b.sidenotes) {
    if (!segOk(n.at.card, n.at.seg)) out.push(`sidenote ${n.id} on missing ${n.at.card}`);
    if (n.kind === "card" && !cards.has(n.card)) out.push(`sidenote ${n.id} points to missing ${n.card}`);
  }
  const stickerRef = (k: Sticker): string | null => {
    const at = k.at;
    if (at.kind === "line") return segOk(at.card, at.seg) ? null : at.card;
    if (!at.on) return null;
    return "card" in at.on ? (cards.has(at.on.card) ? null : at.on.card) : links.has(at.on.link) ? null : at.on.link;
  };
  for (const k of b.stickers) {
    const m = stickerRef(k);
    if (m) out.push(`sticker ${k.id} on missing ${m}`);
  }
  for (const k of b.stickers)
    if (k.q?.answer && !cards.has(k.q.answer)) out.push(`question ${k.id} answered by missing ${k.q.answer}`);
  for (const c of b.cards)
    if (c.kind === "compare")
      for (const k of c.cols) if (!cards.has(k)) out.push(`compare ${c.id} column missing ${k}`);
  for (const id of Object.keys(b.place)) if (!cards.has(id)) out.push(`place for missing card ${id}`);
  for (const s of b.sections)
    if (s.parent && !sections.has(s.parent)) out.push(`section ${s.id} parent missing ${s.parent}`);
  for (const id of Object.keys(b.marks ?? {})) if (!cards.has(id)) out.push(`graph mark for missing card ${id}`);
  for (const id of Object.keys(b.born ?? {})) if (!cards.has(id)) out.push(`creation order for missing card ${id}`);
  for (const c of b.cards) if (c.kind === "code" && c.variants) out.push(...variantProblems(c));
  const twins = new Map<string, string>();
  for (const c of b.cards) {
    if (!c.same) continue;
    const k = twinContent(c),
      p = twins.get(c.same);
    if (p === undefined) twins.set(c.same, k);
    else if (p !== k) out.push(`card ${c.id} differs from the other places of the same card`);
  }
  return out;
}

/** Variant 的不变式：第一个是上游；正显示的那个没有 segs（它的段就是卡上的段），其余每个都有 segs，段 id 和卡上的一一对应 */
function variantProblems(c: CodeCard): string[] {
  const vs = c.variants ?? [];
  const act = activeOf(c);
  const ids = c.segments
    .map((s) => s.id)
    .sort()
    .join();
  const out: string[] = [];
  if (vs[0]?.id !== UPSTREAM) out.push(`card ${c.id}: first variant is not upstream`);
  if (!vs.some((v) => v.id === act)) out.push(`card ${c.id} shows missing variant ${act}`);
  for (const v of vs) {
    if (v.id === act) {
      if (v.segs) out.push(`card ${c.id}: shown variant ${v.id} keeps its own segments`);
    } else if (!v.segs) out.push(`card ${c.id}: variant ${v.id} has no segments`);
    else if (
      v.segs
        .map((s) => s.id)
        .sort()
        .join() !== ids
    )
      out.push(`card ${c.id}: variant ${v.id} segments do not match the card's`);
  }
  return out;
}
