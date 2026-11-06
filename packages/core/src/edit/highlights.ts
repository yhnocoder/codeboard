// Highlights and the sidenotes on them: a sidenote on lines belongs to the Highlight with exactly those lines, and Highlights in a
// segment never overlap. Every change that adds, removes or moves a Highlight or a line sidenote keeps that here.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import {
  activeOf,
  highlightNotes,
  noteSegment,
  sameRange,
  unionRanges,
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
const anchorTo = (n: Sidenote, r: HlRange) => {
  if (n.at.lines && !sameRange(n.at.lines, r)) n.at.lines = [r[0], r[1]];
};

/**
 * Bring a segment's Highlights and its line sidenotes back in step: every sidenote's lines become a Highlight, Highlights that
 * overlap or nest merge into their union, and the sidenotes on them move to it
 */
function fixSegment(s: Segment, notes: Sidenote[]) {
  const before = JSON.stringify(s.hl ?? []);
  const rs = unionRanges([...(s.hl ?? []), ...notes.map((n) => n.at.lines!)]);
  if (JSON.stringify(rs) !== before) setRanges(s, rs);
  for (const n of notes) {
    const r = rs.find(([a, z]) => n.at.lines![0] >= a && n.at.lines![0] <= z);
    if (r) anchorTo(n, r);
  }
}

/**
 * After lines moved (a new version, a Variant switched, cards merged or split, old files read): every line sidenote of these code
 * cards (all of them when none are given) is on a Highlight with exactly its lines, and Highlights in a segment are disjoint
 */
export function fixHighlights(b: Pick<Board, "cards" | "sidenotes">, cards?: Iterable<string>): void {
  const ids = cards ? new Set(cards) : undefined;
  for (const c of b.cards) {
    if (c.kind !== "code" || (ids && !ids.has(c.id))) continue;
    for (const { s, notes } of segsOf(b, c)) fixSegment(s, notes);
  }
}

/**
 * Highlight lines a..z of a segment: Highlights they overlap merge with them into one, and the sidenotes on those move to it.
 * The Highlight they are in now
 */
export function addHighlight(b: Board, s: Segment, lines: readonly number[]): HlRange {
  const [a, z] = [Math.min(lines[0], lines[1]), Math.max(lines[0], lines[1])];
  const hit = (s.hl ?? []).filter(([p, q]) => p <= z && q >= a);
  const r: HlRange = [Math.min(a, ...hit.map((h) => h[0])), Math.max(z, ...hit.map((h) => h[1]))];
  if (hit.length === 1 && sameRange(hit[0], r)) return hit[0];
  const moving = hit.flatMap((h) => highlightNotes(b, s, h));
  setRanges(s, unionRanges([...(s.hl ?? []).filter((h) => !hit.includes(h)), r]));
  for (const n of moving) anchorTo(n, r);
  return r;
}

/** A sidenote added on lines: its Highlight is made (or grown, addHighlight) and the sidenote takes its lines */
export function onHighlight(b: Board, n: Sidenote): void {
  if (!n.at.lines) return;
  const s = noteSegment(b, n);
  if (s) n.at.lines = [...addHighlight(b, s, n.at.lines)];
}

/** Remove Highlights of a segment, and the sidenotes on them with them. How many sidenotes went */
export function removeHighlights(b: Board, s: Segment, ranges: readonly (readonly number[])[]): number {
  const gone = (s.hl ?? []).filter((h) => ranges.some((r) => sameRange(h, r)));
  if (!gone.length) return 0;
  const notes = gone.flatMap((h) => highlightNotes(b, s, h).map((n) => n.id));
  setRanges(
    s,
    (s.hl ?? []).filter((h) => !gone.includes(h)),
  );
  const ids = new Set(notes);
  if (ids.size) b.sidenotes = b.sidenotes.filter((n) => !ids.has(n.id));
  return ids.size;
}
