// Merging code cards into one and splitting them back.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import { replaceCards } from "./refs";
import { unlinkCard } from "./twins";
import { fixHighlights } from "./highlights";
import {
  clone,
  sameVersion,
  sortSegments,
  mergeOverlapping,
  unionRanges,
  type HlRange,
  uid,
  type Board,
  type CodeCard,
  type Place,
  type Segment,
} from "../model";

/**
 * 合并代码卡：段按文件、行号排好，重叠的并起来；连着它们的 Link、Sidenote、Sticker 按文件 + 行搬到新卡上（replaceCards）。
 * target = 被拖到的那张卡（标题、说明、文件顺序以它为准），别的卡的说明转成挂在整张卡上的 Text sidenote。
 * unlink：共享卡先在这块白板上变成副本（别的白板不受影响；mergedFrom 里记的是副本，Unmerge 不会把旧内容写回卡库）
 */
export function mergeCodeCards(
  b: Board,
  ids: string[],
  target: string,
  o: { id?: string; unlink?: (id: string) => boolean } = {},
): { id: string; segments: Segment[] } | null {
  const mid = o.id ?? uid("c");
  const re = new Map<string, string>();
  for (const id of ids) re.set(id, o.unlink?.(id) ? unlinkCard(b, id) : id);
  const now = ids.map((id) => re.get(id)!);
  const orig = now
    .map((id) => b.cards.find((c) => c.id === id))
    .filter((c): c is CodeCard => c?.kind === "code")
    .map(clone);
  if (orig.length < 2) return null;
  const T = orig.find((c) => c.id === re.get(target)) ?? orig[0];
  const segs = mergeOverlapping(
    sortSegments(
      orig.flatMap((c) => c.segments),
      T.segments[0]?.path,
    ),
  );
  // 合并后段 id 变了的，Link / Sidenote 要跟着换：旧段 id → 新段（按文件 + 行找）
  const segFor = (old: Segment, line?: number) =>
    segs.find(
      (s) =>
        s.path === old.path &&
        s.src.kind === old.src.kind &&
        sameVersion(s.version, old.version) &&
        (line === undefined || (line >= s.start && line <= s.end)),
    ) ?? segs[0];
  const oldSegs = new Map(orig.flatMap((c) => c.segments.map((s) => [s.id, s] as const)));
  const TP = b.place[T.id];
  const M: CodeCard = {
    id: mid,
    kind: "code",
    segments: segs,
    title: T.title,
    desc: T.desc,
    hide: T.hide,
    tilt: T.tilt,
    mergedFrom: orig.flatMap((c) => c.mergedFrom ?? [{ card: c, place: clone(b.place[c.id]) }]),
  };
  for (const c of orig)
    if (c !== T && c.desc) b.sidenotes.push({ id: uid("n"), at: { card: mid }, kind: "text", md: c.desc });
  const w = Math.max(560, ...orig.map((c) => b.place[c.id]?.w ?? 560)); // 先量宽度，再删原来的摆放
  replaceCards(
    b,
    orig.map((c) => c.id),
    (at) => {
      const os = at.seg ? oldSegs.get(at.seg) : undefined;
      return { card: mid, seg: os ? segFor(os, at.line).id : undefined };
    },
  );
  b.cards.push(M);
  b.place[mid] = { x: TP?.x ?? 0, y: TP?.y ?? 0, w, section: TP?.section };
  if (b.place[mid].section === undefined) delete b.place[mid].section;
  // the sidenotes came over with their lines: Highlights that overlap now merge, and the sidenotes go with them
  fixHighlights(b, [mid]);
  return { id: mid, segments: clone(M.segments) };
}

/** 拆开：有合并记录就拆回原来的卡（放回原位、Link 回到各自的卡）；没有就按段拆。返回新卡和它们的段 */
export function unmergeCard(b: Board, id: string): { made: string[]; segments: Segment[] } | null {
  const m = b.cards.find((c) => c.id === id);
  const mp = b.place[id];
  if (m?.kind !== "code" || !mp || (!m.mergedFrom && m.segments.length < 2)) return null;
  const f0 = m.mergedFrom?.[0].place;
  const dx = f0 ? mp.x - f0.x : 0,
    dy = f0 ? mp.y - f0.y : 0;
  const pp: Place[] = [];
  const have = new Set(b.cards.map((c) => c.id));
  const parts: CodeCard[] = m.mergedFrom
    ? m.mergedFrom.map((o) => {
        pp.push({ ...clone(o.place), x: o.place.x + dx, y: o.place.y + dy, section: mp.section });
        const k = clone(o.card);
        if (have.has(k.id)) k.id = uid("c"); // 复制过的合并卡再拆：原卡的 id 已经被另一份占了
        // 拆出来的卡看起来和合并卡一样：合并后改过的倾斜算数
        k.tilt = m.tilt;
        return k;
      })
    : m.segments.map((s, i) => {
        pp.push({ x: mp.x + i * 40, y: mp.y + i * 40, w: mp.w, section: mp.section });
        return { id: uid("c"), kind: "code", segments: [clone(s)], hide: m.hide, tilt: m.tilt };
      });
  // 段的高亮 / 隐藏跟着行走
  for (const p of parts)
    for (const s of p.segments) {
      const src = m.segments.filter(
        (q) => q.path === s.path && sameVersion(q.version, s.version) && q.start <= s.end && q.end >= s.start,
      );
      s.hl = unionRanges(
        src
          .flatMap((q) => q.hl ?? [])
          .map(([a, c]): HlRange => [Math.max(a, s.start), Math.min(c, s.end)])
          .filter(([a, c]) => a <= c),
      );
      s.hidden = src
        .flatMap((q) => q.hidden ?? [])
        .map(([a, c]) => [Math.max(a, s.start), Math.min(c, s.end)] as [number, number])
        .filter(([a, c]) => a <= c);
      s.annots = src
        .flatMap((q) => q.annots ?? [])
        .filter((a) => a.line >= s.start && a.line <= s.end)
        .map((a) => ({ ...a }));
      if (!s.annots.length) s.annots = undefined;
      if (!s.hl.length) s.hl = undefined;
      if (!s.hidden.length) s.hidden = undefined;
    }
  const owner = (seg?: string, line?: number) => {
    const ms = m.segments.find((q) => q.id === seg);
    if (!ms) return { card: parts[0].id, seg: undefined as string | undefined };
    for (const p of parts)
      for (const s of p.segments)
        if (
          s.path === ms.path &&
          sameVersion(s.version, ms.version) &&
          (line === undefined ? s.start <= ms.end && s.end >= ms.start : line >= s.start && line <= s.end)
        )
          return { card: p.id, seg: s.id };
    return { card: parts[0].id, seg: undefined };
  };
  replaceCards(b, [id], (at) => (at.seg ? owner(at.seg, at.line) : { card: parts[0].id }));
  const made: string[] = [],
    segments: Segment[] = [];
  parts.forEach((p, i) => {
    b.cards.push(p);
    const q = pp[i];
    if (q.section === undefined) delete q.section;
    b.place[p.id] = q;
    made.push(p.id);
  });
  // a sidenote went to the part with its first line: its Highlight goes along whole
  fixHighlights(b, made);
  for (const p of parts) segments.push(...clone(p.segments));
  return { made, segments };
}
