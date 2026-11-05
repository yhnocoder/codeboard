// Zoomed-out AI summaries (#130). Zoomed out past the board's cut, every innermost Section shows one summary (title + body) and
// every card in no Section one sentence, in place of the cards. A Section with child Sections (nesting by Section.parent, any
// depth: option G of feedback/demo/nested-sections.html) shows a header above its frame instead, and the cards placed in it
// directly one summary of their own (sectionPlan). This file is the pure part both the board and the host run:
// which items get a summary, the board's one font size, the columns (anchored at the source's top-left, growing only right
// and down, aligned sources kept aligned: a port of the layout in feedback/demo/boards-130-viewer.html), the minimum zoom, the
// prompt material (how much to write follows the content alone, never the layout) and what makes a summary pending.
import {
  baseName,
  cardTitle,
  type Board,
  type Card,
  type Place,
  type Section,
  type Summary,
  type SummaryPair,
} from "./model";
import type { Rect } from "./layout";

/** The rules' numbers (board units unless they say otherwise) */
export const SUMMARY = {
  /** Space kept before an obstacle */
  gap: 60,
  /** Edges this close count as aligned */
  align: 4,
  /** Tops this close are one row of the reading order */
  row: 200,
  /** Body line height (in S) */
  lh: 1.5,
  /** A Section's title strip above its frame */
  strip: 30,
  /** A card's column grows at most this far below the card's top */
  looseCap: 1500,
  /** Space between a header and the frame (or the deeper header) below it */
  headGap: 10,
  /** A column's text is at most this many S wide (a wide Section's column keeps its anchor and stops there) */
  maxLine: 28,
  /** The most key phrases a summary keeps bold (the prompt asks for about one per 40 chars); later ones are kept as plain text */
  maxBold: 3,
  /** The highest cut any board has (summaryCut) */
  cutMax: 0.3,
  /** The detent at the cut (board state/summary.ts): a zoom gesture stops there and has to push through it. One mouse-wheel
   *  notch (deltaY 100) pushes through at once; a pinch or trackpad zoom does once its zoom factor past the cut adds up to
   *  e^notch (the sum of |ln f| of its steps) */
  detent: {
    notch: 0.6,
    /** While pushed, the mist rises to this much of the viewport's height at most */
    mist: 0.55,
    /** For the switch it rises to this much: its top band thins out, so past 1 it covers the board whole */
    cover: 1.4,
    /** Let go before it is through, the push drains at this rate (whole pushes per second) */
    drain: 1.2,
    /** …starting this long after the last step (ms) */
    drainAfter: 80,
    /** The switch: the mist covers the board over coverMs, the levels swap under it, and it clears over clearMs */
    coverMs: 220,
    clearMs: 300,
    /** The seal stamps in once the push is this far */
    seal: 0.6,
  },
  /** A pending summary is written again after this long without another change (ms) */
  regenMs: 10 * 60_000,
  /** The minimum zoom: fit-all ÷ this … */
  fitShrink: 1.3,
  /** … kept within these, and this on a board with nothing on it */
  zoomFloor: 0.02,
  zoomCeil: 0.5,
  emptyZoom: 0.1,
} as const;

/** sec: a Section's summary (a Section with child Sections: its header's overview), own: the cards placed in a Section with child
 *  Sections directly (Section.directSummary), card: a card in no Section */
export type SumKey = `sec:${string}` | `card:${string}` | `own:${string}`;
export const secKey = (id: string): SumKey => `sec:${id}`;
export const cardKey = (id: string): SumKey => `card:${id}`;
export const ownKey = (id: string): SumKey => `own:${id}`;
const parseKey = (key: string): { sec?: string; card?: string; own?: string } =>
  key.startsWith("sec:")
    ? { sec: key.slice(4) }
    : key.startsWith("card:")
      ? { card: key.slice(5) }
      : key.startsWith("own:")
        ? { own: key.slice(4) }
        : {};

/** A card that is never summarized, alone or in its Section's summary: sub-board frames, Marks and Free Text */
export const unsummarized = (c: Card) =>
  c.kind === "board" || (c.kind === "note" && (c.look === "mark" || c.look === "freetext"));
/** An unsummarized card that stays at the summary level as it is (sub-board frames, Free Text at its own size); Marks hide */
export const keepsLook = (c: Card) => c.kind === "board" || (c.kind === "note" && c.look === "freetext");

/**
 * A card with no title of its own to show at the summary level: a Note with no heading, an image with no alt text. Its first
 * paragraph is never shown as a title: the AI writes it a short one with its summary (SumRequest.untitled)
 */
export function untitled(c: Card): boolean {
  if (c.title) return false;
  if (c.kind === "note") return !/^\s*#{1,6}\s+\S/.test(c.md.split("\n").find((l) => l.trim()) ?? "");
  return c.kind === "image" && !c.alt;
}

/** The Section a card is in, if that Section exists */
const homeOf = (b: Pick<Board, "sections">, p: Place | undefined) =>
  p?.section && b.sections.some((s) => s.id === p.section) ? p.section : undefined;

/**
 * How a Section shows at the summary level. leaf (no open child Section): its own summary at its top-left. head: a header above
 * its frame, where its title is at the card level, growing upward (the deepest at the bottom when they stack), with a written
 * overview of at most lines lines (level 1: 2, deeper: 1; leaf and pass: 0), and its direct cards (in it,
 * in no child) as one summary. pass: one child and no direct cards: no header, its name is a small line (kick) above the child's
 */
export type SecPlan = {
  role: "leaf" | "head" | "pass";
  depth: number;
  lines: 0 | 1 | 2;
  kick?: string;
  kids: Section[];
  direct: Card[];
};
/** Every open Section's role at the summary level (collapsed Sections and what is in them are not summarized) */
export function sectionPlan(b: Pick<Board, "sections" | "cards" | "place">): Map<string, SecPlan> {
  const ids = new Set(b.sections.map((s) => s.id));
  const kids = new Map<string, Section[]>();
  for (const s of b.sections)
    if (s.parent && ids.has(s.parent) && !s.collapsed) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  const direct = new Map<string, Card[]>();
  for (const c of b.cards) {
    const h = homeOf(b, b.place[c.id]);
    if (h && !unsummarized(c)) direct.set(h, [...(direct.get(h) ?? []), c]);
  }
  const out = new Map<string, SecPlan>();
  const visit = (s: Section, depth: number, kick: string | undefined) => {
    if (out.has(s.id)) return;
    const ks = kids.get(s.id) ?? [],
      dir = direct.get(s.id) ?? [];
    const base = { depth, kids: ks, direct: dir, ...(kick ? { kick } : {}) };
    if (!ks.length) out.set(s.id, { ...base, role: "leaf", lines: 0 });
    else if (ks.length === 1 && !dir.length) {
      out.set(s.id, { ...base, role: "pass", lines: 0 });
      visit(ks[0], depth + 1, kick ? `${kick} › ${s.title}` : s.title);
    } else {
      out.set(s.id, { ...base, role: "head", lines: depth === 1 ? 2 : 1 });
      for (const k of ks) visit(k, depth + 1, undefined);
    }
  };
  for (const s of b.sections) if (!s.collapsed && !(s.parent && ids.has(s.parent))) visit(s, 1, undefined);
  return out;
}
/** The items a board summarizes, by key (what the host may write) */
export function summaryKeys(b: Board): SumKey[] {
  const out: SumKey[] = [];
  for (const [id, p] of sectionPlan(b)) {
    if (p.role !== "pass") out.push(secKey(id));
    if (p.role === "head" && p.direct.some((c) => b.place[c.id])) out.push(ownKey(id));
  }
  for (const c of b.cards) if (b.place[c.id] && !homeOf(b, b.place[c.id]) && !unsummarized(c)) out.push(cardKey(c.id));
  return out;
}

/** One summarized item: its anchor box, what it covers before its column is placed, its title line */
export type SumSource = {
  key: SumKey;
  box: Rect;
  own: Rect;
  title: string;
  /** A code card's title line: the function name and file:line, both from the card header */
  code?: { name: string; at: string };
  /** A loose image card: the image stays as a thumbnail, the summary starts GAP below it */
  image?: Rect;
  /** The current body, for estimating its height where nothing measured it */
  text?: string;
  /** The names of the Sections with one child each it is in (SecPlan pass), shown small above its title */
  kick?: string;
  /** A header above a Section's frame (SecPlan head): level 1 or deeper, the overview lines it shows at most */
  head?: { frame: Rect; level: 1 | 2; lines: 1 | 2; depth: number };
  /** The direct cards of a Section with child Sections, summarized as one */
  group?: true;
};
export type SumInput = { items: SumSource[]; keep: Rect[] };

/**
 * What a board summarizes (sectionPlan): its innermost open Sections (with the cards of their collapsed ones), a header for each
 * Section with child Sections and one item for its direct cards, and the cards in no Section, except sub-board frames, Marks and
 * Free Text (unsummarized; the frames and Free Text stay, as obstacles: keep). rect = a placed card's box, frames = the
 * Sections' frames
 */
export function summarySources(b: Board, rect: (id: string) => Rect | undefined, frames: Map<string, Rect>): SumInput {
  const items: SumSource[] = [],
    keep: Rect[] = [];
  for (const [id, p] of sectionPlan(b)) {
    const s = b.sections.find((x) => x.id === id)!,
      f = frames.get(id);
    if (!f || p.role === "pass") continue;
    const kick = p.kick ? { kick: p.kick } : {};
    if (p.role === "leaf") {
      items.push({
        key: secKey(id),
        box: { ...f },
        own: { x: f.x, y: f.y - SUMMARY.strip, w: f.w, h: f.h + SUMMARY.strip },
        title: s.title,
        text: s.summary?.text,
        ...kick,
      });
      continue;
    }
    items.push({
      key: secKey(id),
      box: { x: f.x, y: f.y, w: f.w, h: 0 },
      own: { x: f.x, y: f.y, w: f.w, h: 0 },
      title: s.title,
      text: s.summary?.text,
      head: { frame: { ...f }, level: p.depth === 1 ? 1 : 2, lines: p.depth === 1 ? 2 : 1, depth: p.depth },
      ...kick,
    });
    const rs = p.direct.map((c) => rect(c.id)).filter((r): r is Rect => !!r);
    if (!rs.length) continue;
    const x0 = Math.min(...rs.map((r) => r.x)),
      y0 = Math.min(...rs.map((r) => r.y));
    const g = {
      x: x0,
      y: y0,
      w: Math.max(...rs.map((r) => r.x + r.w)) - x0,
      h: Math.max(...rs.map((r) => r.y + r.h)) - y0,
    };
    items.push({
      key: ownKey(id),
      box: g,
      own: { ...g },
      title: s.directSummary?.title ?? "",
      text: s.directSummary?.text,
      group: true,
    });
  }
  for (const c of b.cards) {
    const p = b.place[c.id],
      r = p && rect(c.id);
    if (!r) continue;
    if (unsummarized(c)) {
      if (keepsLook(c)) keep.push(r);
      continue;
    }
    if (homeOf(b, p)) continue;
    const it: SumSource = {
      key: cardKey(c.id),
      box: { ...r },
      own: { ...r },
      // its own title once it has one; until then the AI's (none before it is written)
      title: untitled(c) ? (p.summary?.title ?? "") : cardTitle(c, b),
      text: p.summary?.text,
    };
    if (c.kind === "image") {
      it.image = { ...r };
      it.box = { x: r.x, y: r.y + r.h + SUMMARY.gap, w: r.w, h: 0 };
      keep.push(r);
    } else if (c.kind === "code") {
      const s = c.segments[0];
      it.code = { name: cardTitle(c, b), at: s?.path ? `${baseName(s.path)}:${s.start}` : "" };
    }
    items.push(it);
  }
  return { items, keep };
}

/** The board's summary font size from its median column width w: about 56 at 400, 80 at 1600 */
export function summaryFont(w: number): number {
  const b = 24 / Math.log(4),
    a = 56 - b * Math.log(400);
  return Math.min(118, Math.max(52, Math.round(a + b * Math.log(Math.max(1, w)))));
}
/** Zoomed out below this the board shows summaries: summary text is never bigger than about 32 screen px */
export const summaryCut = (S: number) => Math.min(SUMMARY.cutMax, 32 / S);
/** The board's minimum zoom: you can zoom out until the whole board fills about 77 % of the view (content = its bounds) */
export function summaryMinZoom(view: { w: number; h: number }, content: Rect | null): number {
  if (!content || content.w <= 0 || content.h <= 0) return SUMMARY.emptyZoom;
  const fit = Math.min(view.w / content.w, view.h / content.h) * 0.96;
  return Math.min(SUMMARY.zoomCeil, Math.max(SUMMARY.zoomFloor, fit / SUMMARY.fitShrink));
}

/** A column: its extent, the title block height of its row, chars per body line and the body lines its whole extent can hold. A
 *  header's (head) extent ends above its frame */
export type SumCol = Rect & { key: SumKey; hd: number; full: number } & Pick<
    SumSource,
    "title" | "code" | "image" | "kick" | "group"
  > & {
    head?: { level: 1 | 2; lines: 1 | 2 };
  };
export type SumLayout = { S: number; P: number; cut: number; med: number; cols: SumCol[] };
/** Heights read from the page for a column (title block, body), when it has been drawn at its width */
export type SumMeasured = Map<string, { hd: number; tx: number }>;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};
/** Rough width in ems: CJK and full-width characters 1, the rest about half */
const ems = (t: string) => {
  let n = 0;
  for (const ch of t) n += /[⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? 1 : 0.55;
  return n;
};
const linesOf = (t: string, em: number, w: number) => Math.max(1, Math.ceil((ems(t) * em) / Math.max(1, w)));
/** A header's title size, the space under its rule and the rule (in S; Summaries.tsx draws them the same: the demo's .col.h1 / .h2) */
const HEAD = {
  1: { font: 1.12, pad: 0.16, rule: 0.045, gap: 1.12 * 0.32 },
  2: { font: 0.92, pad: 0.12, rule: 0.03, gap: 0.92 * 0.3 },
} as const;
/** The kick line above a title (0.56·S, line height 1.3, 0.2 em under it) */
const kickH = (it: SumSource, S: number) => (it.kick ? Math.ceil(S * 0.56 * 1.3 + S * 0.56 * 0.2) : 0);
/** Space between the title block and the body */
const titleGap = (it: SumSource, S: number) => (it.head ? HEAD[it.head.level].gap : 0.3) * S;
/** Height of a title block drawn nowhere yet (0.8·S bold, line height 1.3; a code card: name line and file:line; a header: its
 *  title and rule), with its kick line */
function titleH(it: SumSource, w: number, S: number) {
  if (it.code) return Math.ceil(S * 0.7 * 1.3) + (it.code.at ? Math.ceil(S * 0.6 * 1.4) : 0);
  if (it.head) {
    const h = HEAD[it.head.level],
      f = S * h.font;
    return kickH(it, S) + Math.ceil(linesOf(it.title, f, w) * f * 1.3 + f * h.pad + Math.max(1, f * h.rule));
  }
  return kickH(it, S) + Math.ceil(linesOf(`■ ${it.title}`, S * 0.8, w) * S * 0.8 * 1.3);
}
const textH = (t: string | undefined, w: number, S: number) =>
  t ? linesOf(t.replace(/\*\*/g, ""), S, w) * S * SUMMARY.lh : 0;

const overlapsY = (o: Rect, y: number, h: number) => !(o.y >= y + h || o.y + o.h <= y);
/** Widen to the right only (the anchor stays): up to want, stopping GAP before the nearest obstacle on the right within [y, y + h] */
function widenRight(box: Rect, h: number, want: number, obs: Rect[]) {
  if (box.w >= want) return box.w;
  let R = Infinity;
  for (const o of obs) if (overlapsY(o, box.y, h) && o.x >= box.x + box.w - 1) R = Math.min(R, o.x - SUMMARY.gap);
  return Math.max(box.w, Math.min(want, R - box.x));
}
/** Sources aligned by left or top edge and of the same width get one column width: the smallest any of them reached */
function unify(items: SumSource[], w: number[]) {
  const par = items.map((_, i) => i);
  const f = (i: number): number => (par[i] === i ? i : (par[i] = f(par[i])));
  const A = SUMMARY.align;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].box,
        b = items[j].box;
      if (Math.abs(a.w - b.w) <= A && (Math.abs(a.x - b.x) <= A || Math.abs(a.y - b.y) <= A)) par[f(i)] = f(j);
    }
  const m = new Map<number, number>();
  items.forEach((_, i) => m.set(f(i), Math.min(m.get(f(i)) ?? Infinity, w[i])));
  return items.map((_, i) => m.get(f(i))!);
}
/** Sources whose left (or top) edges are within ALIGN share the group's smallest one; right and bottom edges stay */
function alignAnchors(items: SumSource[]) {
  for (const [k, d] of [
    ["x", "w"],
    ["y", "h"],
  ] as const) {
    const par = items.map((_, i) => i);
    const f = (i: number): number => (par[i] === i ? i : (par[i] = f(par[i])));
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++)
        if (Math.abs(items[i].box[k] - items[j].box[k]) <= SUMMARY.align) par[f(i)] = f(j);
    const m = new Map<number, number>();
    items.forEach((it, i) => m.set(f(i), Math.min(m.get(f(i)) ?? Infinity, it.box[k])));
    items.forEach((it, i) => {
      const a = m.get(f(i))!,
        off = it.box[k] - a;
      if (off) it.box = { ...it.box, [k]: a, [d]: it.box[d] + off };
    });
  }
}
/** Reading order: rows (tops within ROW) top to bottom, left to right within a row */
function readingOrder(items: SumSource[]) {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: { y: number; items: SumSource[] }[] = [];
  for (const it of sorted) {
    const r = rows.find((q) => Math.abs(q.y - it.box.y) < SUMMARY.row);
    if (r) r.items.push(it);
    else rows.push({ y: it.box.y, items: [it] });
  }
  return rows.sort((a, b) => a.y - b.y).flatMap((r) => r.items.sort((a, b) => a.box.x - b.box.x));
}

/**
 * The summary level's layout: the board's font size S, padding P, cut and every column, in reading order. measured = the title
 * and body heights the page read at the columns' widths (the widths never depend on them); without it, heights are estimated
 * (where nothing was drawn). A column's text is at most SUMMARY.maxLine S wide; at rest its height is the room it has, down to
 * the next column or card below less the gap, so columns never overlap; full = the height its whole text takes (the board fades
 * the last visible lines when it is taller, and shows it all over its neighbours while it is hovered)
 */
export function layoutSummaries(input: SumInput, measured?: SumMeasured): SumLayout {
  const src = input.items.filter((it) => !it.head).map((it) => ({ ...it, box: { ...it.box } }));
  alignAnchors(src);
  const items = readingOrder(src);
  let keep = input.keep;
  // the widths a column could get: its source plus the free space to its right (up to 1416), aligned groups at their smallest
  const reach = unify(
    items,
    items.map((it) =>
      widenRight(
        it.box,
        Math.max(it.box.h, 600),
        Math.max(it.box.w, 1416),
        keep.concat(items.filter((x) => x !== it).map((x) => x.own)),
      ),
    ),
  );
  const med = items.length ? Math.round(median(reach)) : 1190;
  const S = summaryFont(med),
    P = Math.round(S / 3),
    cut = summaryCut(S);
  const heads = placeHeads(
    input.items.filter((it) => it.head),
    keep.concat(items.map((x) => x.own)),
    S,
    P,
    measured,
  );
  // the other columns stop at the headers: they are obstacles like the cards that stay
  keep = keep.concat(heads);
  // widths: each column looks right for room as tall as a title and two body lines
  const hd1 = Math.ceil(S * 0.8 * 1.3);
  const hMin = 2 * P + hd1 + 0.3 * S + 2 * S * SUMMARY.lh,
    want = 12 * S + 2 * P;
  const cols = new Map<string, Rect>();
  for (const it of items) {
    const others = items.filter((x) => x !== it).map((x) => cols.get(x.key) ?? x.own);
    const w = widenRight(it.box, Math.max(it.box.h, hMin), want, keep.concat(others));
    cols.set(it.key, { x: it.box.x, y: it.box.y, w, h: Math.max(it.box.h, 1) });
  }
  const ws = unify(
    items,
    items.map((it) => cols.get(it.key)!.w),
  );
  const wMax = SUMMARY.maxLine * S + 2 * P;
  items.forEach((it, i) => (cols.get(it.key)!.w = Math.min(ws[i], wMax)));
  // heights: sources sharing a top edge start their bodies on one line (the row's tallest title block)
  const hdOf = (it: SumSource) => measured?.get(it.key)?.hd ?? titleH(it, cols.get(it.key)!.w - 2 * P, S);
  const rowOf = new Map<string, string>(),
    rowHd = new Map<string, number>();
  for (const it of items) {
    const first = items.find((u) => Math.abs(u.box.y - it.box.y) <= SUMMARY.align)!;
    rowOf.set(it.key, first.key);
    rowHd.set(first.key, Math.max(rowHd.get(first.key) ?? 0, hdOf(it)));
  }
  // in reading order, each column's final extent is an obstacle for the later ones
  const done = new Map<string, Rect>();
  const extent = (it: SumSource, col: Rect, need: number, cap: number): Rect => {
    const obs = keep.concat(items.filter((x) => x !== it).map((x) => done.get(x.key) ?? cols.get(x.key)!));
    let bottom = it.box.y + cap;
    for (const o of obs)
      if (o.x < col.x + col.w && o.x + o.w > col.x && o.y + o.h > col.y + 1)
        bottom = Math.min(bottom, o.y - SUMMARY.gap);
    const lim = Math.max(0, bottom - col.y);
    return { x: col.x, y: col.y, w: col.w, h: Math.max(Math.min(it.box.h, lim), Math.min(need, lim)) };
  };
  const out: SumCol[] = [];
  for (const it of items) {
    const col = cols.get(it.key)!,
      hd = rowHd.get(rowOf.get(it.key)!)!;
    const tx = measured?.get(it.key)?.tx ?? textH(it.text, col.w - 2 * P, S);
    const cap = it.key.startsWith("card:") ? SUMMARY.looseCap : 1e7;
    const e = extent(it, col, 2 * P + hd + 0.3 * S + tx, cap);
    done.set(it.key, e);
    out.push({
      ...e,
      key: it.key,
      hd,
      full: Math.ceil(2 * P + hd + 0.3 * S + tx),
      title: it.title,
      code: it.code,
      image: it.image,
      ...(it.kick ? { kick: it.kick } : {}),
      ...(it.group ? { group: true as const } : {}),
    });
  }
  return { S, P, cut, med, cols: out.concat(heads) };
}

/**
 * The headers: each above its Section's frame, where the title is at the card level, at most SUMMARY.maxLine S wide, growing
 * upward to its title and overview lines; a header whose frame holds a deeper header's sits on top of that one (the deepest at
 * the bottom, read like a breadcrumb). Never above the room it has: obstacles above it (keep: cards that stay, the other
 * sources) stop it GAP short, and a taller text fades there like any column
 */
function placeHeads(heads: SumSource[], obs: Rect[], S: number, P: number, measured?: SumMeasured): SumCol[] {
  const inside = (a: Rect, f: Rect) =>
    a.x >= f.x - 1 && a.y >= f.y - 1 && a.x + a.w <= f.x + f.w + 1 && a.y + a.h <= f.y + f.h + 1;
  const xov = (a: Rect, x: number, w: number) => a.x < x + w && a.x + a.w > x;
  const placed: { col: SumCol; frame: Rect }[] = [];
  for (const it of [...heads].sort((a, b) => b.head!.depth - a.head!.depth)) {
    const { frame, lines, level } = it.head!;
    const w = Math.min(frame.w, SUMMARY.maxLine * S + 2 * P);
    const hd = measured?.get(it.key)?.hd ?? titleH(it, w - 2 * P, S);
    const tx = measured?.get(it.key)?.tx ?? textH(it.text, w - 2 * P, S);
    const body = (n: number) => (n ? titleGap(it, S) + n : 0);
    const full = Math.ceil(2 * P + hd + body(tx));
    // a measured line is a whole number of pixels (1.5·S rounded up): a text of exactly `lines` lines is not cut
    const most = Math.ceil(2 * P + hd + body(lines * S * SUMMARY.lh)) + 1;
    let bottom = frame.y - SUMMARY.headGap;
    for (const o of placed)
      if (inside(o.frame, frame) && xov(o.col, frame.x, w)) bottom = Math.min(bottom, o.col.y - SUMMARY.headGap);
    let top = -Infinity;
    for (const o of obs.concat(placed.filter((o) => !inside(o.frame, frame)).map((o) => o.col)))
      if (xov(o, frame.x, w) && o.y + o.h <= bottom + 1 && !inside(o, frame))
        top = Math.max(top, o.y + o.h + SUMMARY.gap);
    const h = Math.max(0, Math.floor(Math.min(full, most, bottom - top)));
    placed.push({
      frame,
      col: {
        x: frame.x,
        y: bottom - h,
        w,
        h,
        key: it.key,
        hd,
        full,
        title: it.title,
        head: { level, lines },
        ...(it.kick ? { kick: it.kick } : {}),
      },
    });
  }
  return placed.map((p) => p.col);
}

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
/** The cards a Section's summary is written from: its own and its nested Sections' members */
function membersOf(b: Board, sec: string): Card[] {
  const ids = new Set([sec]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of b.sections)
      if (s.parent && ids.has(s.parent) && !ids.has(s.id)) {
        ids.add(s.id);
        grew = true;
      }
  }
  return b.cards.filter((c) => {
    const h = homeOf(b, b.place[c.id]);
    return !!h && ids.has(h) && !unsummarized(c);
  });
}
/** What a header's overview is written from: each child Section's title and summary (a child with a header: its overview; not
 *  written yet, or a child with one child: what is under it, and its direct cards' summary) */
function kidsOf(b: Board, plan: Map<string, SecPlan>, id: string): { title: string; text: string }[] {
  return (plan.get(id)?.kids ?? []).map((k) => {
    const p = plan.get(k.id);
    if (!p || p.role === "leaf" || (p.role === "head" && k.summary?.text))
      return { title: k.title, text: k.summary?.text ?? "" };
    const parts = kidsOf(b, plan, k.id).map((x) => `${x.title}：${x.text}`);
    if (k.directSummary?.text) parts.unshift(k.directSummary.text);
    return { title: k.title, text: parts.join("\n") };
  });
}
/** What an item is written from: its Section's plan (a key the board has no item for: undefined) */
function itemOf(b: Board, key: string) {
  const k = parseKey(key);
  if (k.card) {
    const c = b.cards.find((x) => x.id === k.card);
    return c && b.place[c.id] ? { kind: "card" as const, cards: [c] } : undefined;
  }
  const id = k.sec ?? k.own;
  const sec = id ? b.sections.find((s) => s.id === id) : undefined;
  const plan = sec && sectionPlan(b);
  const p = plan?.get(sec!.id);
  if (!sec || !plan || !p) return undefined;
  if (k.own) return p.role === "head" && p.direct.length ? { kind: "own" as const, sec, cards: p.direct } : undefined;
  if (p.role === "leaf") return { kind: "leaf" as const, sec, cards: membersOf(b, sec.id) };
  if (p.role === "head") return { kind: "head" as const, sec, cards: p.direct, kids: kidsOf(b, plan, sec.id) };
  return undefined;
}
/**
 * What a summary was written from, as far as regenerating goes: a Section's card count and card titles, a card's title; a
 * header's overview: its children's titles and summaries too. undefined = the board has no such item
 */
export function summarySig(b: Board, key: string): string | undefined {
  const it = itemOf(b, key);
  if (!it) return undefined;
  if (it.kind === "card") return fnv(cardTitle(it.cards[0], b));
  const ts = it.cards.map((c) => cardTitle(c, b));
  const kids = it.kind === "head" ? it.kids.map((x) => `${x.title}\u0001${x.text}`).join("\u0002") : "";
  return fnv(`${ts.length}\n${ts.sort().join("\n")}${kids ? `\u0003${kids}` : ""}`);
}
/**
 * A hash of the content an item's summary is written from: a Section's title and cards (with its nested Sections'), each one's
 * id, title and content; a card's own. Never the layout (moving cards asks nothing) and never the user's edit pairs: they steer a
 * rewrite asked for another reason, and an edit alone leaves its summary fresh. Stored with the summary (Summary.input): the
 * same hash = nothing to ask the AI. undefined = no such item
 */
export function summaryInput(b: Board, key: string): string | undefined {
  const it = itemOf(b, key);
  if (!it) return undefined;
  const head = it.kind === "card" ? "" : `${it.kind === "own" ? "own\u0001" : ""}${it.sec.title}`;
  const kids = it.kind === "head" ? it.kids.map((x) => `${x.title}\u0001${x.text}`).join("\u0002") : "";
  return fnv(
    `${head}\u0003${it.cards
      .map((c) => `${c.id}\u0001${cardTitle(c, b)}\u0001${cardText(c)}`)
      .sort()
      .join("\u0002")}${kids ? `\u0003${kids}` : ""}`,
  );
}
export function summaryOf(b: Board, key: string): Summary | undefined {
  const k = parseKey(key);
  return k.sec
    ? b.sections.find((s) => s.id === k.sec)?.summary
    : k.own
      ? b.sections.find((s) => s.id === k.own)?.directSummary
      : k.card
        ? b.place[k.card]?.summary
        : undefined;
}
/** Write (or clear) an item's summary: one field of its Section (own: Section.directSummary) or of the card's place. false = no
 *  such item */
export function putSummary(b: Board, key: string, s: Summary | undefined): boolean {
  const k = parseKey(key);
  if (k.own) {
    const o = b.sections.find((x) => x.id === k.own);
    if (!o) return false;
    if (s) o.directSummary = s;
    else delete o.directSummary;
    return true;
  }
  const o: Section | Place | undefined = k.sec
    ? b.sections.find((x) => x.id === k.sec)
    : k.card
      ? b.place[k.card]
      : undefined;
  if (!o) return false;
  if (s) o.summary = s;
  else delete o.summary;
  return true;
}
/** Pending: never written, or written from something else than what is there now */
export const summaryPending = (b: Board, key: string) => {
  const s = summaryOf(b, key);
  return !s || s.sig !== summarySig(b, key);
};

/** What the AI is asked to summarize: the item, its cards' titles and contents and the language to write in (how long it is
 *  follows the content, never the layout) */
export type SumRequest = {
  key: SumKey;
  title: string;
  /** A card in no Section: one sentence and a short title; code: the title line is the signature, no title wanted */
  card?: "note" | "code" | "image" | "other";
  /** The card has no title of its own (untitled): the AI also writes a short one, about 12 chars or 6 English words */
  untitled?: true;
  /** The cards placed directly in a Section with child Sections (title = that Section's), summarized as one: the AI writes their
   *  short title too */
  group?: true;
  /** A header's one-sentence overview: the child Sections' titles and summaries (cards = the Section's direct cards) */
  overview?: { title: string; text: string }[];
  cards: { title: string; text: string }[];
  lang: "zh" | "en";
  sig: string;
  /** summaryInput now: the summary written from this request carries it */
  input: string;
  /** The user's edits of this summary, newest first: the rewrite keeps their emphasis, wording and length (the newer wins where
   *  they conflict) and updates only the content */
  pairs?: SummaryPair[];
  /** The user's edits elsewhere (the host fills them in: summaryExamples), in place of the prompt's own examples */
  examples?: SumExample[];
};
/** A worked example for the AI: a Section's title, its content condensed, and the summary the user wrote for it */
export type SumExample = { title: string; content: string; summary: string };
/** Card material for the prompt: at most this much in all (130-deepseek-prompt.md) */
const ALL_CHARS = 6000;
function cardText(c: Card): string {
  switch (c.kind) {
    case "note":
      // without images and tags
      return c.md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<[^>\n]+>/g, "");
    case "code":
      return c.segments.map((s) => `// ${s.path}:${s.start}\n${s.text.slice(0, 80).join("\n")}`).join("\n");
    case "image":
      return c.alt ?? "";
    case "web":
      return [c.url, c.meta?.title, c.meta?.desc].filter(Boolean).join("\n");
    case "links":
      return c.items.map((i) => i.title || i.url).join("\n");
    default:
      return "";
  }
}
const CJK = /[㐀-鿿]/g;
/** Chinese when the board's text has a fair share of Chinese characters */
export function boardLang(text: string): "zh" | "en" {
  const n = (text.match(CJK) ?? []).length,
    l = (text.match(/[A-Za-z]/g) ?? []).length;
  return n > 0 && n * 3 >= l * 0.5 ? "zh" : "en";
}
/** The request for an item, sized by its column in layout. undefined = no such item or column */
export function summaryRequest(b: Board, key: SumKey, layout: SumLayout): SumRequest | undefined {
  const col = layout.cols.find((c) => c.key === key),
    sig = summarySig(b, key),
    it = itemOf(b, key);
  if (!col || sig === undefined || !it) return undefined;
  const cards = it.cards;
  let left = ALL_CHARS;
  const material = cards.map((c) => {
    const t = cardText(c).slice(0, Math.max(0, left));
    left -= t.length;
    return { title: untitled(c) ? "（无标题）" : cardTitle(c, b), text: t };
  });
  const sec = it.kind === "card" ? undefined : it.sec;
  const kids = it.kind === "head" ? it.kids : undefined;
  const one = cards[0];
  const all = [
    sec?.title ?? "",
    ...(kids ?? []).map((x) => `${x.title}\n${x.text}`),
    ...material.map((m) => `${m.title}\n${m.text}`),
  ].join("\n");
  return {
    key,
    title: sec ? sec.title : one && !untitled(one) ? cardTitle(one, b) : "（无标题）",
    ...(it.kind === "own" ? { group: true as const } : {}),
    ...(kids ? { overview: kids } : {}),
    ...(sec
      ? {}
      : {
          card: one?.kind === "note" || one?.kind === "code" || one?.kind === "image" ? one.kind : ("other" as const),
          ...(one && untitled(one) ? { untitled: true as const } : {}),
        }),
    cards: material,
    lang: boardLang(all),
    sig,
    input: summaryInput(b, key) ?? "",
    ...(summaryOf(b, key)?.pairs?.length ? { pairs: summaryOf(b, key)!.pairs } : {}),
  };
}

const EXAMPLE_CHARS = 240;
/**
 * The user's edited Section summaries on these boards (each Section's newest edit), most recent first, at most n, as examples
 * for the AI: its title, its cards condensed and the user's text. but = the summary being written (not its own example)
 */
export function summaryExamples(boards: Board[], n: number, but?: { board: string; key: string }): SumExample[] {
  const all: (SumExample & { at: number })[] = [];
  for (const b of boards) {
    const plan = sectionPlan(b);
    for (const s of b.sections) {
      const p = s.summary?.pairs?.[0];
      // a Section's own summary only: an overview is written another way
      if (!p || plan.get(s.id)?.role !== "leaf" || (but && but.board === b.id && but.key === secKey(s.id))) continue;
      const content = membersOf(b, s.id)
        .map((c) => `${cardTitle(c, b)}：${cardText(c).replace(/\s+/g, " ").trim()}`)
        .join(" ")
        .slice(0, EXAMPLE_CHARS);
      all.push({ title: s.title, content, summary: p.user, at: p.at });
    }
  }
  return all
    .sort((a, b) => b.at - a.at)
    .slice(0, n)
    .map(({ at: _, ...e }) => e);
}

/** The AI's answer → a summary (JSON as asked; a bare text answer is taken as the body). About one bold key phrase per 40 chars kept (exactly one under 50, SUMMARY.maxBold at most). undefined = empty */
export function readSummaryReply(raw: string, r: SumRequest, at: number): Summary | undefined {
  const t = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?|\n?```$/g, "")
    .trim();
  let text = t,
    title: string | undefined;
  try {
    const j = JSON.parse(t) as { text?: unknown; title?: unknown };
    if (typeof j.text === "string") text = j.text;
    if (typeof j.title === "string") title = j.title;
  } catch {
    /* plain text */
  }
  // about one bold key phrase per 40 chars, at most maxBold, exactly one under 50: the ones past that stay as plain text
  text = text.trim();
  const len = text.replace(/\*\*/g, "").length,
    most = len < 50 ? 1 : Math.min(SUMMARY.maxBold, Math.max(1, Math.round(len / 40)));
  let bold = 0;
  text = text.replace(/\*\*(.+?)\*\*/g, (_, x: string) => (bold++ < most ? `**${x}**` : x));
  if (!text) return undefined;
  const s: Summary = { text, at, sig: r.sig, input: r.input };
  if (r.pairs?.length) s.pairs = r.pairs;
  if (title?.trim() && ((r.card && r.card !== "code") || r.group)) s.title = title.trim();
  return s;
}
