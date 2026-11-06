// A segment's lines moved (a new version, Relocate, another commit): everything pointing at its lines follows them by content.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import { cornerOf } from "./internal";
import { allLinks, allStickers } from "./refs";
import { fixHighlights } from "./highlights";
import { mapLines } from "../diff";
import {
  activeOf,
  clone,
  sameVersion,
  unionRanges,
  type Board,
  type CodeCard,
  type Link,
  type Segment,
  type Sidenote,
} from "../model";

/** 旧行号 → 新行号；0 = 这一行在新版本里没了 */
export type LineMap = (line: number) => number;

/** 按内容对齐（core 的 LCS + 相似行配对）：没变的行跟过去，改过的行跟到配对的那一行 */
export function lineMapOf(old: Pick<Segment, "text" | "start">, now: Pick<Segment, "text" | "start">): LineMap {
  const m = mapLines(old.text, old.start, now.text, now.start, true);
  return (l) => m.get(l) ?? 0;
}

/** 一段行映射到新版本：取区间里还在的行的首尾 */
function mapRange(map: LineMap, a: number, e: number): [number, number] | null {
  let lo = Infinity,
    hi = -Infinity;
  for (let l = a; l <= e; l++) {
    const m = map(l);
    if (m) {
      lo = Math.min(lo, m);
      hi = Math.max(hi, m);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 把卡里的一段换成新的（同一个段 id）：新版本 Update、HEAD 下只是挪了位置、Relocate 都走这里。
 * 段上的隐藏 / 高亮（Highlight 和挂在上面的 Sidenote 按同一个 mapRange 走，之后重叠的合并：fixHighlights），Link 两端、Sidenote、Sticker 的行号都按 map 搬过去（moveLineRefs）；
 * 行没了的：Link 端点退到卡头并标上 lost（画成红色，等用户重连或删掉），Sidenote 改挂整卡并标上 lineRemoved，Sticker 挪到卡的右上角。
 * 合并卡的 mergedFrom（拆开时用的原卡快照）里落在这段上的段也一起换版本、挪行，Unmerge 时行锚还对得上。
 * review：挂在内容变了的行上的 Sidenote 标上 review（新版本的标签），提醒复查（Update 时传）。
 * fix: false = the caller brings Highlights and sidenotes back in step itself once it is done (switchVariant)
 */
export function rebaseSegment(
  b: Board,
  cardId: string,
  ns: Segment,
  map: LineMap = lineMapOf(findSeg(b, cardId, ns.id) ?? ns, ns),
  o: { review?: string; notes?: (n: Sidenote) => boolean; fix?: false } = {},
): void {
  const owner = findOwner(b, cardId);
  const i = owner?.segments.findIndex((s) => s.id === ns.id) ?? -1;
  if (!owner || i < 0) return;
  const old = owner.segments[i];
  owner.segments[i] = remapSegMarks(ns, old, map);
  for (const o of owner.mergedFrom ?? []) {
    o.card.segments = o.card.segments.map((s) => {
      if (
        s.path !== old.path ||
        s.src.kind !== old.src.kind ||
        !sameVersion(s.version, old.version) ||
        s.start > old.end ||
        s.end < old.start
      )
        return s;
      const r = mapRange(map, Math.max(s.start, old.start), Math.min(s.end, old.end));
      if (!r) return s;
      return {
        ...remapSegMarks(s, s, map),
        start: r[0],
        end: r[1],
        text: ns.text.slice(r[0] - ns.start, r[1] - ns.start + 1),
        version: ns.version,
      };
    });
  }
  // 有 Variant 的卡：「只在某个 Variant」的 Sidenote 行号按那个 Variant 的代码算，只跟着当前显示的那个挪
  const notes = o.notes ?? (owner.variants ? (n: Sidenote) => !n.variant || n.variant === activeOf(owner) : undefined);
  moveLineRefs(b, cardId, old, ns, map, { review: o.review, notes });
  // Highlights and the sidenotes on them moved by the same map; ones that now overlap merge
  if (o.fix !== false) fixHighlights(b, [cardId]);
}

/**
 * 新段 ns 带上旧段的隐藏 / 高亮 / 标注（按 map 映射过去，没了的行去掉）。返回一份拷贝。
 * 标注要被标的字还在那一行里：原位置不是那几个字时在新的这一行里找同样的字（找第一处），找不到就去掉
 */
export function remapSegMarks(
  ns: Segment,
  old: Pick<Segment, "hidden" | "hl" | "annots" | "text" | "start">,
  map: LineMap,
): Segment {
  const hidden = (old.hidden ?? []).map(([a, e]) => mapRange(map, a, e)).filter((r): r is [number, number] => !!r);
  // a Highlight follows its lines as a sidenote on them does (moveNoteLines), so the two stay the same lines
  const hl = unionRanges((old.hl ?? []).map(([a, e]) => mapRange(map, a, e)).filter((r): r is [number, number] => !!r));
  const annots = (old.annots ?? []).flatMap((a) => {
    const line = map(a.line),
      words = (old.text[a.line - old.start] ?? "").slice(a.from, a.to);
    const t = line ? ns.text[line - ns.start] : undefined;
    if (!line || t === undefined || !words) return [];
    const from = t.slice(a.from, a.to) === words ? a.from : t.indexOf(words);
    return from < 0 ? [] : [{ ...a, line, from, to: from + words.length }];
  });
  const out = clone(ns);
  if (hidden.length) out.hidden = hidden;
  else delete out.hidden;
  if (hl.length) out.hl = hl;
  else delete out.hl;
  if (annots.length) out.annots = annots;
  else delete out.annots;
  return out;
}

/**
 * 挂在这张卡这一段上的 Sidenote（which 选的）行号按 map 挪；行没了改挂整卡并标上 lineRemoved。
 * mark：挪之前看一眼（Update 时标 review）
 */
export function moveNoteLines(
  b: Board,
  cardId: string,
  segId: string,
  map: LineMap,
  which: (n: Sidenote) => boolean = () => true,
  mark?: (n: Sidenote, lines: [number, number]) => void,
): void {
  for (const n of b.sidenotes) {
    if (n.at.card !== cardId || n.at.seg !== segId || !n.at.lines || !which(n)) continue;
    mark?.(n, n.at.lines);
    const r = mapRange(map, n.at.lines[0], n.at.lines[1]);
    if (r) n.at.lines = r;
    else {
      n.at = { card: cardId };
      n.lineRemoved = true;
    }
  }
}

/**
 * 一段换了内容之后，白板上指着这段的行号跟过去：Link 两端、Sidenote、Sticker（rebaseSegment 的后半段）。
 * notes：哪些 Sidenote 要挪（缺省全部；别的白板改了共享卡时，跟着卡来的 Sidenote 那边已经挪好了，这边只挪自己的）。
 * review：挂着的行内容变了的 Sidenote 标上 review
 */
export function moveLineRefs(
  b: Board,
  cardId: string,
  old: Segment,
  ns: Segment,
  map: LineMap,
  o: { notes?: (n: Sidenote) => boolean; review?: string } = {},
): void {
  const moveEnd = (l: Link, k: "from" | "to") => {
    const e = l[k];
    if (e.card !== cardId || e.seg !== ns.id || !e.line) return;
    const m = map(e.line);
    if (m) {
      e.line = m;
      return;
    }
    e.seg = undefined;
    e.line = undefined;
    l.lost = { ...l.lost, [k]: true };
  };
  for (const l of allLinks(b)) {
    moveEnd(l, "from");
    moveEnd(l, "to");
  }
  const review = o.review;
  moveNoteLines(
    b,
    cardId,
    ns.id,
    map,
    o.notes,
    review
      ? (n, [a, e]) => {
          if (linesChanged(old, ns, map, a, e)) n.review = review;
        }
      : undefined,
  );
  for (const k of allStickers(b)) {
    if (k.at.kind !== "line" || k.at.card !== cardId || k.at.seg !== ns.id) continue;
    const m = map(k.at.line);
    if (m) k.at.line = m;
    else k.at = cornerOf(b, cardId);
  }
}

/** 旧段的 a..e 行在新段里变了没有（没了，或那一行的内容不一样） */
function linesChanged(
  old: Pick<Segment, "text" | "start">,
  ns: Pick<Segment, "text" | "start">,
  map: LineMap,
  a: number,
  e: number,
): boolean {
  for (let l = a; l <= e; l++) {
    const m = map(l);
    if (!m || (old.text[l - old.start] ?? "") !== (ns.text[m - ns.start] ?? "")) return true;
  }
  return false;
}

/** 换成新段之前数一下：挂在这段内容会变的行上的 Sidenote（Update 对话框里提醒） */
export function notesOnChangedLines(b: Pick<Board, "cards" | "sidenotes">, cardId: string, ns: Segment): Sidenote[] {
  const old = (b.cards.find((c) => c.id === cardId) as CodeCard | undefined)?.segments?.find((s) => s.id === ns.id);
  if (!old) return [];
  const map = lineMapOf(old, ns);
  return b.sidenotes.filter(
    (n) =>
      n.at.card === cardId &&
      n.at.seg === ns.id &&
      n.at.lines &&
      linesChanged(old, ns, map, n.at.lines[0], n.at.lines[1]),
  );
}

/** 段只是整体挪了几行（内容没变） */
export const shiftBy =
  (d: number): LineMap =>
  (l) =>
    l + d;

function findOwner(b: Board, cardId: string) {
  const c = b.cards.find((k) => k.id === cardId);
  return c?.kind === "code" ? c : undefined;
}
const findSeg = (b: Board, cardId: string, segId: string) => findOwner(b, cardId)?.segments.find((s) => s.id === segId);
