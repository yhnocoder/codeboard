// The board's self-check: references to things that are not there (always empty after an edit)
import {
  activeOf,
  localNote,
  noteSegment,
  within,
  sameRange,
  twinContent,
  UPSTREAM,
  type Board,
  type CodeCard,
  type Segment,
  type Sticker,
} from "../model";

/**
 * 白板里指向不存在的东西的引用（应该永远是空的）：Link 两端、Sidenote、Sticker、问题的解答、Compare 的栏、Place、Section 父子，以及重复的 id。
 * The Shelf is checked the same way: its arrows, stickers, places and Sections (a shelved card is on the Shelf only, never on the
 * canvas too; a shelved sticker is bound to its own entry's arrows).
 * 给测试和 mutate 的自检用；返回每一处问题的说明。
 */
export function danglingRefs(b: Board): string[] {
  const out: string[] = [];
  const cards = new Map<string, Board["cards"][number]>();
  for (const c of b.cards) {
    if (cards.has(c.id)) out.push(`duplicate card id ${c.id}`);
    cards.set(c.id, c);
  }
  const shelf = b.shelf ?? [];
  const allLinks = [...b.links, ...shelf.flatMap((e) => e.links)];
  const links = new Set(b.links.map((l) => l.id));
  const sections = new Set([...b.sections, ...shelf.flatMap((e) => e.sections)].map((s) => s.id));
  const segOk = (card: string, seg?: string) => {
    const c = cards.get(card);
    if (!c) return false;
    return !seg || (c.kind === "code" && c.segments.some((s) => s.id === seg));
  };
  for (const l of allLinks)
    for (const e of [l.from, l.to])
      if (!segOk(e.card, e.seg)) out.push(`link ${l.id} → missing ${e.card}${e.seg ? `/${e.seg}` : ""}`);
  // Note 的块：只能在 Note 上，和行不能同时有；块还在不在由白板拆 Markdown 时看（blockAt 找不到就画在卡头）
  for (const l of allLinks)
    for (const e of [l.from, l.to]) {
      if (!e.block) continue;
      const c = cards.get(e.card);
      if (c && c.kind !== "note") out.push(`link ${l.id} → block on ${e.card}, which is not a Note`);
      if (e.seg !== undefined || e.line !== undefined) out.push(`link ${l.id} → both a block and a line on ${e.card}`);
      if (!Number.isInteger(e.block.i) || e.block.i < 0 || !e.block.h)
        out.push(`link ${l.id} → bad block ${JSON.stringify(e.block)} on ${e.card}`);
    }
  // 标记的组合（LinkMarks）：类型挡住了写法，这里挡住从别处来的数据
  for (const l of allLinks as { id: string; gen?: true; call?: unknown; rpc?: unknown; back?: true }[]) {
    const extra = (["call", "rpc", "back"] as const).filter((k) => l[k]);
    if (l.gen && extra.length) out.push(`generated-from link ${l.id} also has ${extra.join(", ")}`);
  }
  for (const n of b.sidenotes) {
    const at = n.at;
    if (n.kind === "text" && n.q?.answers?.some((a) => !a.id || !a.md.trim()))
      out.push(`question ${n.id} has an answer with no id or text`);
    if (at.section !== undefined) {
      if (!sections.has(at.section)) out.push(`sidenote ${n.id} on missing section ${at.section}`);
      if (n.variant || n.boardOnly) out.push(`sidenote ${n.id} on section ${at.section} is Board-only or in a variant`);
      continue;
    }
    if (at.card === undefined) {
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) out.push(`free sidenote ${n.id} at no point`);
      if (n.variant || n.boardOnly) out.push(`free sidenote ${n.id} is Board-only or in a variant`);
      continue;
    }
    if (!segOk(at.card, at.seg)) out.push(`sidenote ${n.id} on missing ${at.card}`);
    // a Note's block, as an arrow's end on one: only on a Note, never with lines
    if (at.block) {
      if (cards.get(at.card)?.kind !== "note")
        out.push(`sidenote ${n.id} on a block of ${at.card}, which is not a Note`);
      if (at.seg !== undefined || at.lines) out.push(`sidenote ${n.id} on both a block and lines of ${at.card}`);
      if (!Number.isInteger(at.block.i) || at.block.i < 0 || !at.block.h)
        out.push(`sidenote ${n.id} on bad block ${JSON.stringify(at.block)} of ${at.card}`);
    }
    if (n.variant) {
      const c = cards.get(at.card);
      if (c && !(c.kind === "code" && c.variants?.some((v) => v.id === n.variant)))
        out.push(`sidenote ${n.id} on missing variant ${n.variant} of ${at.card}`);
    }
    // a sidenote on lines lies in its segment; one that goes along with the card is on the segment's Highlight with exactly those
    // lines, a local one is a Highlight of its own (edit/highlights.ts)
    const s = n.at.lines && noteSegment(b, n);
    const where = () => `sidenote ${n.id} on lines ${n.at.lines!.join("–")} of ${n.at.card}/${n.at.seg}`;
    if (s && !(n.at.lines![0] <= n.at.lines![1] && within(n.at.lines!, [s.start, s.end])))
      out.push(`${where()}, outside its segment ${s.start}–${s.end}`);
    else if (s && !localNote(n) && !s.hl?.some((r) => sameRange(r, n.at.lines)))
      out.push(`${where()}, which are no Highlight`);
  }
  for (const c of b.cards)
    if (c.kind === "code")
      for (const s of [...c.segments, ...(c.variants ?? []).flatMap((v) => v.segs ?? [])])
        out.push(...rangeProblems(c.id, s));
  const stickerRef = (k: Sticker, links: Set<string>): string | null => {
    const at = k.at;
    if (at.kind === "line") return segOk(at.card, at.seg) ? null : at.card;
    if (!at.on) return null;
    return "card" in at.on ? (cards.has(at.on.card) ? null : at.on.card) : links.has(at.on.link) ? null : at.on.link;
  };
  const stickers: [Sticker, Set<string>][] = [
    ...b.stickers.map((k): [Sticker, Set<string>] => [k, links]),
    ...shelf.flatMap((e) => {
      const own = new Set(e.links.map((l) => l.id));
      return e.stickers.map((k): [Sticker, Set<string>] => [k, own]);
    }),
  ];
  for (const [k, ls] of stickers) {
    const m = stickerRef(k, ls);
    if (m) out.push(`sticker ${k.id} on missing ${m}`);
  }
  for (const c of b.cards)
    if (c.kind === "compare")
      for (const k of c.cols) if (!cards.has(k)) out.push(`compare ${c.id} column missing ${k}`);
  const onCanvas = new Set(b.sections.map((s) => s.id));
  for (const [id, p] of Object.entries(b.place)) {
    if (!cards.has(id)) out.push(`place for missing card ${id}`);
    if (p.section && !onCanvas.has(p.section)) out.push(`card ${id} is in missing section ${p.section}`);
  }
  const shelved = new Set<string>();
  for (const e of shelf) {
    if (!Object.keys(e.place).length && !e.sections.length) out.push(`shelf entry ${e.id} is empty`);
    for (const id of Object.keys(e.place)) {
      if (!cards.has(id)) out.push(`shelf entry ${e.id} keeps missing card ${id}`);
      if (b.place[id]) out.push(`card ${id} is both on the board and on the shelf`);
      if (shelved.has(id)) out.push(`card ${id} is in two shelf entries`);
      shelved.add(id);
    }
  }
  // what stays on the canvas does not hang on a shelved card (a Compare's columns with it)
  for (const id of [...shelved]) {
    const c = cards.get(id);
    if (c?.kind === "compare") c.cols.forEach((k) => shelved.add(k));
  }
  for (const l of b.links)
    if (shelved.has(l.from.card) || shelved.has(l.to.card))
      out.push(`link ${l.id} on the board touches a shelved card`);
  for (const k of b.stickers) {
    const at = k.at;
    const on = at.kind === "line" ? at.card : at.on && "card" in at.on ? at.on.card : undefined;
    if (on && shelved.has(on)) out.push(`sticker ${k.id} on the board is on shelved card ${on}`);
  }
  const secIds = new Set<string>();
  for (const s of [...b.sections, ...shelf.flatMap((e) => e.sections)]) {
    if (secIds.has(s.id)) out.push(`duplicate section id ${s.id}`);
    secIds.add(s.id);
    if (s.parent && !sections.has(s.parent)) out.push(`section ${s.id} parent missing ${s.parent}`);
  }
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

/** A segment's Highlights: each first ≤ last inside the segment, sorted, none overlapping another */
function rangeProblems(card: string, s: Segment): string[] {
  const out: string[] = [];
  (s.hl ?? []).forEach(([a, z], i, rs) => {
    if (!Number.isInteger(a) || !Number.isInteger(z) || a > z)
      out.push(`card ${card}/${s.id}: bad Highlight ${a}–${z}`);
    else if (a < s.start || z > s.end)
      out.push(`card ${card}/${s.id}: Highlight ${a}–${z} outside the segment's lines ${s.start}–${s.end}`);
    if (i && rs[i - 1][1] >= a)
      out.push(`card ${card}/${s.id}: Highlight ${a}–${z} overlaps or precedes the one before`);
  });
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
