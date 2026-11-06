// A code card's Highlights as drawn (as the board shows them: the segment's own and this board's local sidenotes', shownRanges): the
// rows each one covers, the sidenotes on it, and its least indented line's indent (where its notes start). One pass over the rows; the drawn elements are keyed by each Highlight's key, so they stay while its lines do
import { createMemo } from "solid-js";
import { shownRanges, within, type HlRange, type Sidenote } from "@codeboard/core";
import { state } from "../../state/store";
import { pops } from "../../state/pop";
import { exportHidden } from "../../state/export";
import * as act from "../../actions";
import type { CodeCx } from "./cx";

type TextNote = Extract<Sidenote, { kind: "text" }>;
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
  /** its Always Show notes: drawn under its last row */
  always: TextNote[];
  /** its least indented non-blank line's leading spaces and tabs (where its notes start: CodeBody codeAt) */
  lead: string;
  review: boolean;
};

/** Where a line's text starts, in columns: a space is one, a tab goes on to the next tab stop (every 4, .src tab-size) */
function leadCols(t: string): number {
  let x = 0;
  for (const ch of t) {
    if (ch === " ") x++;
    else if (ch === "\t") x = (Math.floor(x / 4) + 1) * 4;
    else break;
  }
  return x;
}

export function useHighlights(cx: CodeCx) {
  const list = createMemo<Hx[]>(() => {
    const c = cx.card(),
      rows = cx.rows(),
      out: Hx[] = [];
    // an export leaving some sidenotes out: drawn as if they were not there
    const hide = exportHidden(),
      gone = (n: Sidenote) => hide.has(n.id);
    const seen = hide.size
      ? { cards: state.board.cards, sidenotes: state.board.sidenotes.filter((n) => !gone(n)) }
      : state.board;
    // per segment: its Highlights in order, filled in as the rows go by (a segment's rows come in line order)
    const bySeg = new Map<string, { s: (typeof c.segments)[number]; hs: Hx[]; at: number; lead: number[] }>();
    for (const s of c.segments) {
      const hs = shownRanges(seen, s).map(
        (r): Hx => ({
          key: act.highlightKey(c.id, s.id, r),
          seg: s.id,
          lines: [r[0], r[1]],
          first: -1,
          last: -1,
          notes: [],
          always: [],
          lead: "",
          review: false,
        }),
      );
      if (hs.length) bySeg.set(s.id, { s, hs, at: 0, lead: hs.map(() => Number.POSITIVE_INFINITY) });
    }
    if (!bySeg.size) return out;
    rows.forEach((row, i) => {
      if (row.t !== "line" && row.t !== "gap") return;
      const e = bySeg.get(row.seg);
      if (!e) return;
      const [from, to] = row.t === "line" ? [row.line, row.line] : [row.from, row.to];
      while (e.at < e.hs.length && e.hs[e.at].lines[1] < from) e.at++;
      for (let k = e.at; k < e.hs.length && e.hs[k].lines[0] <= to; k++) {
        const h = e.hs[k];
        if (h.first < 0) h.first = i;
        h.last = i;
        if (row.t !== "line") continue;
        const t = e.s.text[row.line - e.s.start] ?? "";
        const n = leadCols(t);
        if (t.trim() && n < e.lead[k]) {
          e.lead[k] = n;
          h.lead = t.slice(0, t.length - t.trimStart().length);
        }
      }
    });
    for (const n of act.sidenotesOf(c.id)) {
      if (gone(n)) continue;
      const e = n.at.lines && n.at.seg ? bySeg.get(n.at.seg) : undefined;
      const h = e?.hs.find((x) => within(n.at.lines!, x.lines));
      if (!h) continue;
      h.notes.push(n);
      if (n.review) h.review = true;
      if (n.kind === "text" && n.alwaysShow) h.always.push(n);
    }
    for (const e of bySeg.values()) for (const h of e.hs) if (h.first >= 0) out.push(h);
    return out;
  });
  /** The Highlights' keys, the same array while they stay the same: what the drawn elements are keyed by */
  const keys = createMemo(() => list().map((h) => h.key), [], {
    equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]),
  });
  const byKey = createMemo(() => new Map(list().map((h) => [h.key, h])));
  /** row → the Highlight it is in */
  const byRow = createMemo(() => {
    const m = new Map<number, Hx>();
    for (const h of list()) for (let i = h.first; i <= h.last; i++) m.set(i, h);
    return m;
  });
  /** row → the Highlight that ends on it */
  const endRow = createMemo(() => new Map(list().map((h) => [h.last, h])));
  /** The Highlights whose popup is open: drawn as hovered */
  const open = createMemo(() => {
    const s = new Set<string>();
    for (const p of pops()) if (p.pop.kind === "highlight") s.add(act.highlightKey(p.pop.card, p.pop.seg, p.pop.lines));
    return s;
  });
  return { list, keys, byKey, byRow, endRow, open, marked: () => list().some((h) => h.notes.length) };
}
