// 改白板时要一起维护的引用：删卡要带走挂在它上面的 Link / Sidenote；
// 一段代码换了行号（新版本、挪了位置、Relocate）时，指着这段的行号都要跟着走。
// 纯函数，直接改传进来的 board（白板里在 mutate 的 produce 里调用）。
import { mapLines } from "./diff";
import type { Board, End, Segment } from "./model";

/** 删掉这些卡（Compare 连同两栏），以及连着它们的 Link、挂在它们上面或指向它们的 Sidenote */
export function removeCards(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  for (const c of b.cards) if (c.kind === "compare" && gone.has(c.id)) c.cols.forEach((k) => gone.add(k.id));
  b.cards = b.cards.filter((c) => !gone.has(c.id));
  b.links = b.links.filter((l) => !gone.has(l.from.card) && !gone.has(l.to.card));
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.at.card) && !(n.kind === "card" && gone.has(n.card)));
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
 * 段上的隐藏 / 高亮，Link 两端、Sidenote 的行号都按 map 搬过去；
 * 行没了的：Link 端点退回整张卡，Sidenote 改挂整卡并标上 lineRemoved。
 */
export function rebaseSegment(b: Board, cardId: string, ns: Segment, map: LineMap = lineMapOf(findSeg(b, cardId, ns.id) ?? ns, ns)): void {
  const owner = findOwner(b, cardId);
  const i = owner?.segments.findIndex((s) => s.id === ns.id) ?? -1;
  if (!owner || i < 0) return;
  const old = owner.segments[i];
  const hidden = (old.hidden ?? []).map(([a, e]) => mapRange(map, a, e)).filter(Boolean) as [number, number][];
  const hl = (old.hl ?? []).map(map).filter(Boolean);
  owner.segments[i] = { ...ns, hidden: hidden.length ? hidden : undefined, hl: hl.length ? hl : undefined };
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
}

/** 段只是整体挪了几行（内容没变） */
export const shiftBy = (d: number): LineMap => (l) => l + d;

function findOwner(b: Board, cardId: string) {
  for (const c of b.cards) {
    if (c.kind === "code" && c.id === cardId) return c;
    if (c.kind === "compare") for (const k of c.cols) if (k.id === cardId) return k;
  }
  return undefined;
}
const findSeg = (b: Board, cardId: string, segId: string) => findOwner(b, cardId)?.segments.find((s) => s.id === segId);
