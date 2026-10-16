// 改白板时要一起维护的引用：删卡要带走挂在它上面的 Link / Sidenote；
// 一段代码换了行号（新版本、挪了位置、Relocate）时，指着这段的行号都要跟着走。
// 纯函数，直接改传进来的 board（白板里在 mutate 的 produce 里调用）。
import { mapLines } from "./diff";
import { sameVersion, type Board, type End, type Segment, type Sticker } from "./model";

/** 删掉这些卡（Compare 连同两栏）和它们的摆放，以及连着它们的 Link、挂在它们上面或指向它们的 Sidenote、贴在它们上面的 Sticker */
export function removeCards(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  for (const c of b.cards) if (c.kind === "compare" && gone.has(c.id)) c.cols.forEach((k) => gone.add(k));
  b.cards = b.cards.filter((c) => !gone.has(c.id));
  for (const id of gone) delete b.place[id];
  b.links = b.links.filter((l) => !gone.has(l.from.card) && !gone.has(l.to.card));
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.at.card) && !(n.kind === "card" && gone.has(n.card)));
  b.stickers = b.stickers.filter((k) => k.at.kind === "canvas" || !gone.has(k.at.card));
  pruneStickers(b);
}

/** 删掉这些 Link，绑在它们上面的 Sticker 一起删 */
export function removeLinks(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.links = b.links.filter((l) => !gone.has(l.id));
  pruneStickers(b);
}

/** 绑着的卡 / 箭头没了的 Sticker 一起删（删卡、删箭头之后调用；撤销时一起回来） */
export function pruneStickers(b: Board): void {
  const cards = new Set(b.cards.map((c) => c.id)), links = new Set(b.links.map((l) => l.id));
  b.stickers = b.stickers.filter((k) => {
    const on = k.at.kind === "canvas" ? k.at.on : undefined;
    return !on || ("card" in on ? cards.has(on.card) : links.has(on.link));
  });
}

/** 旧卡上的一个位置（整卡，或某段某行）在替换它的卡上落在哪；seg 为空 = 落在整张卡上 */
export type Retarget = (at: { card: string; seg?: string; line?: number }) => { card: string; seg?: string };

/**
 * 一批卡被别的卡替换（合并、拆开、拆 Compare）：指着它们的 Link 两端、Sidenote（挂在上面的和 kind card 指向它的）、
 * Sticker（行上、卡角、绑在卡上的）都按 to 搬过去。搬完两端落在同一张卡上的 Link 删掉，绑着它的 Sticker 一起删。
 * 删卡本身由调用方做（replaceCards / removeCards）；这里只管引用，任何换卡的操作都应该走这里，而不是各自改一遍。
 */
export function retargetCards(b: Board, ids: Iterable<string>, to: Retarget): void {
  const gone = new Set(ids);
  const moveEnd = (e: End): End => {
    const o = to(e);
    return { card: o.card, seg: o.seg, line: o.seg ? e.line : undefined };
  };
  const touched = new Set<string>();
  for (const l of b.links) {
    const f = gone.has(l.from.card), t = gone.has(l.to.card);
    if (f) l.from = moveEnd(l.from);
    if (t) l.to = moveEnd(l.to);
    if (f || t) touched.add(l.id);
  }
  b.links = b.links.filter((l) => !(touched.has(l.id) && l.from.card === l.to.card));
  for (const n of b.sidenotes) {
    if (gone.has(n.at.card)) {
      const o = to({ card: n.at.card, seg: n.at.seg, line: n.at.lines?.[0] });
      n.at = { card: o.card, seg: o.seg, lines: o.seg ? n.at.lines : undefined };
    }
    if (n.kind === "card" && gone.has(n.card)) n.card = to({ card: n.card }).card;
  }
  for (const k of b.stickers) {
    const at = k.at;
    if (at.kind === "line" && gone.has(at.card)) {
      const o = to({ card: at.card, seg: at.seg, line: at.line });
      k.at = o.seg ? { kind: "line", card: o.card, seg: o.seg, line: at.line } : { kind: "card", card: o.card };
    } else if (at.kind === "card" && gone.has(at.card)) k.at = { kind: "card", card: to({ card: at.card }).card };
    else if (at.kind === "canvas" && at.on && "card" in at.on && gone.has(at.on.card)) at.on = { card: to({ card: at.on.card }).card };
  }
  pruneStickers(b);
}

/** 换卡：引用按 to 搬走（retargetCards），再删掉旧卡和它们的摆放。只删这几张：拆 Compare 时它的栏留下 */
export function replaceCards(b: Board, ids: Iterable<string>, to: Retarget): void {
  const gone = new Set(ids);
  retargetCards(b, gone, to);
  b.cards = b.cards.filter((c) => !gone.has(c.id));
  for (const id of gone) delete b.place[id];
}

/**
 * 白板里指向不存在的东西的引用（应该永远是空的）：Link 两端、Sidenote、Sticker、Compare 的栏、Place、Section 父子，以及重复的 id。
 * 给测试和 mutate 的自检用；返回每一处问题的说明。
 */
export function danglingRefs(b: Board): string[] {
  const out: string[] = [];
  const cards = new Map<string, Board["cards"][number]>();
  for (const c of b.cards) { if (cards.has(c.id)) out.push(`duplicate card id ${c.id}`); cards.set(c.id, c); }
  const links = new Set(b.links.map((l) => l.id));
  const sections = new Set(b.sections.map((s) => s.id));
  const segOk = (card: string, seg?: string) => {
    const c = cards.get(card);
    if (!c) return false;
    return !seg || (c.kind === "code" && c.segments.some((s) => s.id === seg));
  };
  for (const l of b.links) for (const e of [l.from, l.to]) if (!segOk(e.card, e.seg)) out.push(`link ${l.id} → missing ${e.card}${e.seg ? `/${e.seg}` : ""}`);
  for (const n of b.sidenotes) {
    if (!segOk(n.at.card, n.at.seg)) out.push(`sidenote ${n.id} on missing ${n.at.card}`);
    if (n.kind === "card" && !cards.has(n.card)) out.push(`sidenote ${n.id} points to missing ${n.card}`);
  }
  const stickerRef = (k: Sticker): string | null => {
    const at = k.at;
    if (at.kind === "line") return segOk(at.card, at.seg) ? null : at.card;
    if (at.kind === "card") return cards.has(at.card) ? null : at.card;
    if (!at.on) return null;
    return "card" in at.on ? (cards.has(at.on.card) ? null : at.on.card) : links.has(at.on.link) ? null : at.on.link;
  };
  for (const k of b.stickers) { const m = stickerRef(k); if (m) out.push(`sticker ${k.id} on missing ${m}`); }
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) if (!cards.has(k)) out.push(`compare ${c.id} column missing ${k}`);
  for (const id of Object.keys(b.place)) if (!cards.has(id)) out.push(`place for missing card ${id}`);
  for (const s of b.sections) if (s.parent && !sections.has(s.parent)) out.push(`section ${s.id} parent missing ${s.parent}`);
  return out;
}

/** 旧行号 → 新行号；0 = 这一行在新版本里没了 */
export type LineMap = (line: number) => number;

/** 按内容对齐（core 的 LCS + 相似行配对）：没变的行跟过去，改过的行跟到配对的那一行 */
export function lineMapOf(old: Pick<Segment, "text" | "start">, now: Pick<Segment, "text" | "start">): LineMap {
  const m = mapLines(old.text, old.start, now.text, now.start, true);
  return (l) => m.get(l) ?? 0;
}

/** 一段行映射到新版本：取区间里还在的行的首尾 */
export function mapRange(map: LineMap, a: number, e: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let l = a; l <= e; l++) { const m = map(l); if (m) { lo = Math.min(lo, m); hi = Math.max(hi, m); } }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 把卡里的一段换成新的（同一个段 id）：新版本 Update、HEAD 下只是挪了位置、Relocate 都走这里。
 * 段上的隐藏 / 高亮，Link 两端、Sidenote、Sticker 的行号都按 map 搬过去；
 * 行没了的：Link 端点退回整张卡，Sidenote 改挂整卡并标上 lineRemoved，Sticker 挪到卡片角上。
 * 合并卡的 mergedFrom（拆开时用的原卡快照）里落在这段上的段也一起换版本、挪行，Unmerge 时行锚还对得上。
 */
export function rebaseSegment(b: Board, cardId: string, ns: Segment, map: LineMap = lineMapOf(findSeg(b, cardId, ns.id) ?? ns, ns)): void {
  const owner = findOwner(b, cardId);
  const i = owner?.segments.findIndex((s) => s.id === ns.id) ?? -1;
  if (!owner || i < 0) return;
  const old = owner.segments[i];
  const hidden = (old.hidden ?? []).map(([a, e]) => mapRange(map, a, e)).filter(Boolean) as [number, number][];
  const hl = (old.hl ?? []).map(map).filter(Boolean);
  owner.segments[i] = { ...ns, hidden: hidden.length ? hidden : undefined, hl: hl.length ? hl : undefined };
  for (const o of owner.mergedFrom ?? []) {
    o.card.segments = o.card.segments.map((s) => {
      if (s.path !== old.path || s.src.kind !== old.src.kind || !sameVersion(s.version, old.version) || s.start > old.end || s.end < old.start) return s;
      const r = mapRange(map, Math.max(s.start, old.start), Math.min(s.end, old.end));
      if (!r) return s;
      const sh = (s.hidden ?? []).map(([a, e]) => mapRange(map, a, e)).filter(Boolean) as [number, number][];
      const sl = (s.hl ?? []).map(map).filter(Boolean);
      return { ...s, start: r[0], end: r[1], text: ns.text.slice(r[0] - ns.start, r[1] - ns.start + 1), version: ns.version, hidden: sh.length ? sh : undefined, hl: sl.length ? sl : undefined };
    });
  }
  const moveEnd = (e: End) => {
    if (e.card !== cardId || e.seg !== ns.id || !e.line) return;
    const m = map(e.line);
    if (m) e.line = m; else { e.seg = undefined; e.line = undefined; }
  };
  for (const l of b.links) { moveEnd(l.from); moveEnd(l.to); }
  for (const n of b.sidenotes) {
    if (n.at.card !== cardId || n.at.seg !== ns.id || !n.at.lines) continue;
    const r = mapRange(map, n.at.lines[0], n.at.lines[1]);
    if (r) n.at.lines = r; else { n.at = { card: cardId }; n.lineRemoved = true; }
  }
  for (const k of b.stickers) {
    if (k.at.kind !== "line" || k.at.card !== cardId || k.at.seg !== ns.id) continue;
    const m = map(k.at.line);
    if (m) k.at.line = m; else k.at = { kind: "card", card: cardId };
  }
}

/** 段只是整体挪了几行（内容没变） */
export const shiftBy = (d: number): LineMap => (l) => l + d;

function findOwner(b: Board, cardId: string) {
  const c = b.cards.find((k) => k.id === cardId);
  return c?.kind === "code" ? c : undefined;
}
const findSeg = (b: Board, cardId: string, segId: string) => findOwner(b, cardId)?.segments.find((s) => s.id === segId);
