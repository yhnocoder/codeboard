// A code card's Highlights as drawn: the rows each one covers, the sidenotes on it, and where its notes start (the indent of its
// least indented line, after the card's dedent)
import { createMemo } from "solid-js";
import { sameRange, shownText, type HlRange, type Sidenote } from "@codeboard/core";
import { pops } from "../../state/pop";
import * as act from "../../actions";
import type { CodeCx } from "./cx";

export type Hx = {
  /** highlightKey: where its popup finds its gutter area */
  key: string;
  seg: string;
  lines: HlRange;
  /** the first and last row it covers (a line, or a gap of hidden lines) */
  first: number;
  last: number;
  /** the sidenotes on it this card shows (a Variant's own are left out on the others) */
  notes: Sidenote[];
  /** its least indented non-blank line's indent, in code columns after the dedent */
  indent: number;
  review: boolean;
};

export function useHighlights(cx: CodeCx, ded: () => number) {
  const list = createMemo<Hx[]>(() => {
    const c = cx.card(),
      rows = cx.rows(),
      notes = act.sidenotesOf(c.id),
      out: Hx[] = [];
    for (const s of c.segments)
      for (const r of s.hl ?? []) {
        let first = -1,
          last = -1,
          lead = Number.POSITIVE_INFINITY;
        rows.forEach((row, i) => {
          const on =
            row.seg === s.id &&
            ((row.t === "line" && row.line >= r[0] && row.line <= r[1]) ||
              (row.t === "gap" && row.from <= r[1] && row.to >= r[0]));
          if (!on) return;
          if (first < 0) first = i;
          last = i;
          if (row.t !== "line") return;
          const t = shownText(s, row.line, undefined).replace(/\t/g, "    ");
          if (t.trim()) lead = Math.min(lead, t.length - t.trimStart().length);
        });
        if (first < 0) continue;
        const mine = notes.filter((n) => n.at.seg === s.id && sameRange(n.at.lines, r));
        out.push({
          key: act.highlightKey(c.id, s.id, r),
          seg: s.id,
          lines: [r[0], r[1]],
          first,
          last,
          notes: mine,
          indent: Number.isFinite(lead) ? Math.max(0, lead - ded()) : 0,
          review: mine.some((n) => !!n.review),
        });
      }
    return out;
  });
  /** row → the Highlight it is in */
  const byRow = createMemo(() => {
    const m = new Map<number, Hx>();
    for (const h of list()) for (let i = h.first; i <= h.last; i++) m.set(i, h);
    return m;
  });
  /** The Highlights whose popup is open: drawn as hovered */
  const open = createMemo(() => {
    const s = new Set<string>();
    for (const p of pops()) if (p.pop.kind === "highlight") s.add(act.highlightKey(p.pop.card, p.pop.seg, p.pop.lines));
    return s;
  });
  return { list, byRow, open, marked: () => list().some((h) => h.notes.length) };
}
