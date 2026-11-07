// Highlights and the sidenotes on them. A segment's own Highlights (Segment.hl, which a shared card carries to every board) never
// overlap and lie inside the segment; a sidenote on lines that goes along with the card is on one of them, with exactly its lines.
// A local sidenote (board-only, or a Card sidenote: localNote) is a Highlight of its own on this board: its lines are never written
// into Segment.hl, so no other board's Highlight depends on it and nothing another board does to Segment.hl takes it away; the board
// shows the union of both (shownRanges). Every change that adds, removes or moves a Highlight or a line sidenote keeps this here.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import {
  activeOf,
  highlightNotes,
  localNote,
  noteSegment,
  sameRange,
  unionRanges,
  within,
  WIDENED,
  type Board,
  type CodeCard,
  type HlRange,
  type Segment,
  type Sidenote,
} from "../model";

/** The segments a card's Highlights are kept in, each with the sidenotes whose lines count in it (noteSegment) */
function segsOf(b: Pick<Board, "sidenotes">, c: CodeCard): { s: Segment; notes: Sidenote[] }[] {
  const act = activeOf(c);
  const shown = (n: Sidenote) => !c.variants?.length || !n.variant || n.variant === act;
  const out = c.segments.map((s) => ({
    s,
    notes: b.sidenotes.filter((n) => n.at.card === c.id && n.at.seg === s.id && n.at.lines && shown(n)),
  }));
  for (const v of c.variants ?? [])
    for (const s of v.segs ?? [])
      out.push({
        s,
        notes: b.sidenotes.filter((n) => n.at.card === c.id && n.at.seg === s.id && n.at.lines && n.variant === v.id),
      });
  return out;
}

const setRanges = (s: Segment, rs: HlRange[]) => {
  if (rs.length) s.hl = rs;
  else delete s.hl;
};
/** n's lines become r (a new array only when they change, so a check finds nothing to write) */
const anchorTo = (n: Sidenote, r: readonly number[]) => {
  if (n.at.lines && !sameRange(n.at.lines, r)) n.at.lines = [r[0], r[1]];
};
/** Lines cut to the segment's; lines wholly outside it become its nearest line */
const clampTo = (s: Segment, [a, z]: readonly number[]): HlRange => {
  const p = Math.min(Math.max(a, s.start), s.end);
  return [p, Math.max(p, Math.min(z, s.end))];
};

/**
 * Bring a segment's Highlights and its line sidenotes back in step: Highlights are cut to the segment's lines, every sidenote's lines
 * too; a sidenote that goes along with the card makes its lines a Highlight, Highlights that overlap or nest merge into their union
 * and those sidenotes move to it (marked for review when that widened their lines, unless review is false: an old file read).
 * Local sidenotes keep their own lines (shownRanges joins them)
 */
function fixSegment(s: Segment, notes: Sidenote[], review: boolean) {
  for (const n of notes) anchorTo(n, clampTo(s, n.at.lines!));
  const shared = notes.filter((n) => !localNote(n));
  const before = JSON.stringify(s.hl ?? []);
  const own = (s.hl ?? []).filter(([a, z]) => z >= s.start && a <= s.end).map((r) => clampTo(s, r));
  const rs = unionRanges([...own, ...shared.map((n) => n.at.lines!)]);
  if (JSON.stringify(rs) !== before) setRanges(s, rs);
  for (const n of shared) {
    const r = rs.find((h) => within(n.at.lines!, h));
    if (!r || sameRange(r, n.at.lines)) continue;
    if (review) n.review = WIDENED;
    anchorTo(n, r);
  }
}

/**
 * After lines moved (a new version, a Variant switched, cards merged or split, old files read): every line sidenote of these code
 * cards (all of them when none are given) lies in its segment, the ones that go along with the card each on a Highlight with exactly
 * its lines, and Highlights in a segment are disjoint and inside it. o.review false: widened lines are not marked (an old file read)
 */
export function fixHighlights(
  b: Pick<Board, "cards" | "sidenotes">,
  cards?: Iterable<string>,
  o: { review?: false } = {},
): void {
  const ids = cards ? new Set(cards) : undefined;
  for (const c of b.cards) {
    if (c.kind !== "code" || (ids && !ids.has(c.id))) continue;
    for (const { s, notes } of segsOf(b, c)) fixSegment(s, notes, o.review !== false);
  }
}

/** A part cut from segments (a split, an unmerge) keeps their Highlights on its lines, cut at its ends */
export function clipHighlights(part: Segment, from: readonly Segment[]): void {
  setRanges(
    part,
    unionRanges(
      from
        .flatMap((q) => q.hl ?? [])
        .map(([a, z]): HlRange => [Math.max(a, part.start), Math.min(z, part.end)])
        .filter(([a, z]) => a <= z),
    ),
  );
}

/**
 * Highlight lines a..z of a segment: its own Highlights they overlap merge with them into one, and the sidenotes on those that go
 * along with the card move to it. The Highlight they are in now
 */
export function addHighlight(b: Board, s: Segment, lines: readonly number[]): HlRange {
  const [a, z] = [Math.min(lines[0], lines[1]), Math.max(lines[0], lines[1])];
  const hit = (s.hl ?? []).filter(([p, q]) => p <= z && q >= a);
  const r: HlRange = [Math.min(a, ...hit.map((h) => h[0])), Math.max(z, ...hit.map((h) => h[1]))];
  if (hit.length === 1 && sameRange(hit[0], r)) return hit[0];
  const moving = hit.flatMap((h) => highlightNotes(b, s, h).filter((n) => !localNote(n)));
  setRanges(s, unionRanges([...(s.hl ?? []).filter((h) => !hit.includes(h)), r]));
  for (const n of moving) anchorTo(n, r);
  return r;
}

/**
 * A sidenote added on lines: one that goes along with the card gets its Highlight (made, or grown, addHighlight) and takes its
 * lines; a local one is a Highlight of its own (cut to the segment)
 */
export function onHighlight(b: Board, n: Sidenote): void {
  if (!n.at.lines) return;
  const s = noteSegment(b, n);
  if (!s) return;
  if (localNote(n)) anchorTo(n, clampTo(s, n.at.lines));
  else n.at.lines = [...addHighlight(b, s, n.at.lines)];
}

/**
 * Remove Highlights as the board shows them (shownRanges): the segment's own Highlights inside them, and every sidenote on their
 * lines, local ones too. How many sidenotes went
 */
export function removeHighlights(b: Board, s: Segment, ranges: readonly (readonly number[])[]): number {
  const inside = (l: readonly number[]) => ranges.some((r) => within(l, r));
  const ids = new Set(
    highlightNotes(b, s, [s.start, s.end])
      .filter((n) => inside(n.at.lines!))
      .map((n) => n.id),
  );
  const hl = s.hl ?? [];
  const kept = hl.filter((h) => !inside(h));
  if (kept.length === hl.length && !ids.size) return 0;
  setRanges(s, kept);
  if (ids.size) b.sidenotes = b.sidenotes.filter((n) => !ids.has(n.id));
  return ids.size;
}

/**
 * A sidenote just made local (board-only): the segment's own Highlight that was there only for it (exactly its lines, no other
 * sidenote that goes along with the card on it) goes, so the other boards no longer show it. The sidenote's lines stay a Highlight
 * on this board (shownRanges)
 */
export function dropOwnHighlight(b: Board, n: Sidenote): void {
  const s = n.at.lines && noteSegment(b, n);
  if (!s?.hl) return;
  const r = s.hl.find((h) => sameRange(h, n.at.lines));
  if (!r || highlightNotes(b, s, r).some((x) => x !== n && !localNote(x))) return;
  setRanges(
    s,
    s.hl.filter((h) => h !== r),
  );
}
