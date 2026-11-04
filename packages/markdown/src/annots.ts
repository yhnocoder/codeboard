// Where the labels of the {text|note} annotations go. Each label (.md-annot-n) is centred over its words by CSS; AnnotFit
// measures the labels of a static render or an editor and moves them by --ax (sideways) and --rise (rows up: the line keeps
// that much more room above it, so a raised label never covers the line before). placeLabels decides, one line at a time:
// a label that would run past its block (paragraph, list item, cell) is pulled back inside, left edge first. Two labels on
// the same line that would overlap are spread apart: the earlier one (left to right) moves left and the later one right,
// half the overlap each, as far as each can while staying inside the block and over its own arrow (what one cannot take,
// the other does). When they still cannot be separated, the later one goes up one row (its arrow gets longer) and the same
// is tried there. An arrow that goes up past a lower row is kept free there, so no label is drawn over it.
import type { Measure } from "./ui/measure";

/** One label: c = its arrow's centre, w = its width, both in px from the block's left edge */
export type LabelBox = { c: number; w: number };
/** Where it goes: x = its left edge from the block's left, row = rows above the usual one (0: the usual one) */
export type LabelPlace = { x: number; row: number };

/** Space kept between two labels of one row (px) */
const LABEL_GAP = 4;
/** How much of a label stays on each side of its arrow (px) */
const COVER = 6;
/** Arrows are 10px wide: half of that, plus a little air */
const ARROW = 6;
/** Rows above the usual one at most; past that a label stays where it would be alone */
const MAX_ROW = 3;
const EPS = 0.01;

/** What a row holds: a label (i: which; lo..hi: where its left edge may go) or an arrow going up past it (i = -1, fixed) */
type Slot = { i: number; x: number; w: number; lo: number; hi: number };
const clear = (a: { x: number; w: number }, b: { x: number; w: number }) =>
  a.x + a.w + LABEL_GAP <= b.x + EPS || b.x + b.w + LABEL_GAP <= a.x + EPS;

/** labels: one line's labels in any order; room: the block's width. Returns their places in the same order */
export function placeLabels(labels: readonly LabelBox[], room: number): LabelPlace[] {
  const out: LabelPlace[] = labels.map(() => ({ x: 0, row: 0 }));
  const rows: Slot[][] = Array.from({ length: MAX_ROW + 1 }, () => []);
  const order = labels.map((_, i) => i).sort((a, b) => labels[a].c - labels[b].c);
  for (const i of order) {
    const { c, w } = labels[i];
    const alone = w > room ? 0 : Math.max(0, Math.min(c - w / 2, room - w));
    // the label stays inside the block and over its arrow
    const m = Math.min(COVER, w / 2);
    let lo = Math.max(0, c + m - w),
      hi = Math.min(room - w, c - m);
    if (lo > hi) lo = hi = alone;
    const me: Slot = { i, x: alone, w, lo: Math.min(lo, alone), hi: Math.max(hi, alone) };
    let row = 0;
    for (; row <= MAX_ROW; row++) if (fits(rows[row], me)) break;
    if (row > MAX_ROW) {
      row = MAX_ROW;
      me.x = alone;
    }
    rows[row].push(me);
    for (let r = 0; r < row; r++) rows[r].push({ i: -1, x: c - ARROW, w: 2 * ARROW, lo: c - ARROW, hi: c - ARROW });
    out[i] = { x: me.x, row };
    for (let r = 0; r <= row; r++) for (const s of rows[r]) if (s.i >= 0) out[s.i].x = s.x;
  }
  return out;
}

/** Finds me (at its centred place) a place on this row, moving the one label it overlaps aside if need be; false: none */
function fits(row: Slot[], me: Slot): boolean {
  const hit = row.filter((s) => !clear(s, me));
  if (!hit.length) return true;
  const want = me.x;
  // spread apart from the one label it overlaps on its left: each moves half, or what the other cannot
  const a = hit.length === 1 && hit[0].i >= 0 && hit[0].x <= want ? hit[0] : undefined;
  if (a) {
    const rest = row.filter((s) => s !== a);
    const aMin = Math.max(a.lo, ...rest.filter((s) => s.x + s.w <= a.x + EPS).map((s) => s.x + s.w + LABEL_GAP));
    const bMax = Math.min(me.hi, ...rest.filter((s) => s.x >= want + me.w - EPS).map((s) => s.x - LABEL_GAP - me.w));
    const need = a.x + a.w + LABEL_GAP - want,
      left = Math.max(0, a.x - aMin),
      right = Math.max(0, bMax - want);
    if (left + right >= need - EPS) {
      let sa = Math.min(need / 2, left);
      const sb = Math.min(need - sa, right);
      sa = need - sb;
      const ax = a.x - sa,
        bx = want + sb;
      const moved = { ...a, x: ax },
        mine = { ...me, x: bx };
      if (clear(moved, mine) && rest.every((s) => clear(s, moved) && clear(s, mine))) {
        a.x = ax;
        me.x = bx;
        return true;
      }
    }
  }
  // otherwise only this one moves, as little as it can
  let best: number | null = null;
  for (const x of row.flatMap((s) => [s.x + s.w + LABEL_GAP, s.x - LABEL_GAP - me.w])) {
    if (x < me.lo - EPS || x > me.hi + EPS || !row.every((s) => clear(s, { x, w: me.w }))) continue;
    if (best === null || Math.abs(x - want) < Math.abs(best - want)) best = x;
  }
  if (best === null) return false;
  me.x = best;
  return true;
}

/*
 * The measuring: offset* sizes and positions (not changed by the camera's zoom, scrolling, the --ax transform, nor by --rise,
 * which only makes the line taller), all read in the page's measuring round (createMeasure) before anything is written, and
 * only the values that changed are written. The static render fits on hydrate, the editor after each update. Fonts that arrive
 * late (a CJK font is fetched per unicode-range, KaTeX's fonts) make a label wider: a ResizeObserver measures again, as when
 * the block gets wider or narrower (a card resized).
 */
const BLOCK = "p, li, td, th, h1, h2, h3, h4, h5, h6, summary";
type Found = LabelBox & { a: HTMLElement; block: HTMLElement; below: boolean; h: number; top: number; bot: number };

/** The annotations' fitting of one Markdown instance */
export class AnnotFit {
  /** each watched element's root (a label is watched to catch its font arriving) and how to stop watching it */
  private rootOf = new WeakMap<Element, HTMLElement>();
  private unwatch = new WeakMap<Element, () => void>();
  constructor(private measure: Measure) {}
  fit(el: HTMLElement) {
    if (!el.isConnected) {
      if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(() => {
          if (el.isConnected) this.fit(el);
        });
      return;
    }
    this.watch(el, el);
    let k = this.keys.get(el);
    if (!k) this.keys.set(el, (k = {}));
    this.measure.queue(k, () => this.read(el));
  }
  /** each root's key in the measuring round (the page measures its own things in it, keyed by its elements) */
  private keys = new WeakMap<HTMLElement, object>();
  private watch(t: HTMLElement, root: HTMLElement) {
    this.rootOf.set(t, root);
    if (this.unwatch.has(t) || typeof ResizeObserver !== "function") return;
    const stop = this.measure.observe(t, () => {
      const r = this.rootOf.get(t) ?? t;
      if (!t.isConnected || !r.isConnected || !r.getElementsByClassName("md-annot").length) {
        stop();
        this.unwatch.delete(t);
      } else this.fit(r);
    });
    this.unwatch.set(t, stop);
  }
  private read(el: HTMLElement) {
    if (!el.isConnected) return;
    const found: Found[] = [];
    for (const a of el.getElementsByClassName("md-annot") as HTMLCollectionOf<HTMLElement>) {
      const n = a.querySelector<HTMLElement>(":scope > .md-annot-n");
      if (!n) continue;
      this.watch(n, el);
      const block = a.parentElement?.closest<HTMLElement>(BLOCK) ?? el;
      if (a.offsetParent !== block.offsetParent && a.offsetParent !== block) continue;
      const inside = a.offsetParent === block,
        left = inside ? a.offsetLeft : a.offsetLeft - block.offsetLeft,
        top = inside ? a.offsetTop : a.offsetTop - block.offsetTop,
        cs = getComputedStyle(a);
      found.push({
        a,
        block,
        below: a.hasAttribute("data-below"),
        c: left + a.offsetWidth / 2,
        w: n.offsetWidth,
        h: n.offsetHeight,
        // the annotated words, without the rail their label is in: which line they are on
        top: top + parseFloat(cs.paddingTop),
        bot: top + a.offsetHeight - parseFloat(cs.paddingBottom),
      });
    }
    const out: [HTMLElement, string, string][] = [];
    for (const line of lines(found)) {
      const step = Math.ceil(Math.max(...line.map((f) => f.h))) + 2;
      placeLabels(line, line[0].block.clientWidth).forEach((p, i) => {
        const f = line[i];
        out.push([f.a, `${Math.round((p.x - (f.c - f.w / 2)) * 2) / 2}px`, p.row ? `${p.row * step}px` : ""]);
      });
    }
    const todo = out.filter(
      ([a, ax, rise]) => a.style.getPropertyValue("--ax") !== ax || a.style.getPropertyValue("--rise") !== rise,
    );
    if (!todo.length) return;
    return () => {
      for (const [a, ax, rise] of todo) {
        a.style.setProperty("--ax", ax);
        if (rise) a.style.setProperty("--rise", rise);
        else a.style.removeProperty("--rise");
      }
    };
  }
}

/** The annotations by line: the same block, labels on the same side, and words that share most of their height */
function lines(found: Found[]): Found[][] {
  const sides = new Map<HTMLElement, [Found[], Found[]]>();
  for (const f of found) {
    let s = sides.get(f.block);
    if (!s) sides.set(f.block, (s = [[], []]));
    s[f.below ? 1 : 0].push(f);
  }
  const out: Found[][] = [];
  for (const side of sides.values())
    for (const fs of side) {
      fs.sort((x, y) => x.top - y.top);
      let cur: Found[] = [],
        top = 0,
        bot = 0;
      for (const f of fs) {
        if (cur.length && Math.min(bot, f.bot) - Math.max(top, f.top) > Math.min(bot - top, f.bot - f.top) / 2) {
          cur.push(f);
          top = Math.min(top, f.top);
          bot = Math.max(bot, f.bot);
          continue;
        }
        if (cur.length) out.push(cur);
        cur = [f];
        top = f.top;
        bot = f.bot;
      }
      if (cur.length) out.push(cur);
    }
  return out;
}
