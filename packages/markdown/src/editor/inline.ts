// Paragraphs, headings and table-cell paragraphs hold their Markdown source as plain text. This plugin only draws it:
// formatting comes from the parser (spans.ts) as decorations, and the markers (`**`, `## `, `](url)`) show only where
// the caret is. Moving the caret never changes the document. The decorations stay frozen while the mouse is down, while
// a selection is non-empty, during IME composition and for a moment after a single click (a double-click must land on
// the same layout as the first click).
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { REVEAL_AFTER_CLICK } from "../ui/timing";
import { blockInfo, flat, type Span } from "./spans";
import { atomWidget, ellipsis, foldButton, foldRange, imageBelow, mathBelow, placeCaret } from "./widgets";
import { measureImages, slideImages } from "./imageslide";

type Tag = NonNullable<Span["tag"]>;

type St = { head: number | null; focused: boolean; expand: number | null; decos: DecorationSet };
type Meta = { reveal?: true; blur?: true; focus?: true; expand?: number | null };
export const inlineKey = new PluginKey<St>("cbInline");

/** Input state shared by the plugin's handlers (only one editor takes input at a time) */
const ui = { mouseDown: false, pending: false, composing: false, timer: 0 as ReturnType<typeof setTimeout> | 0 };
/** The editor whose images slide (one editor is open at a time), and what was measured before the redraw (imageslide.ts) */
let slideView: EditorView | null = null, slideFrom: ReturnType<typeof measureImages> | null = null;

/** A range the caret crosses in one step: [from, to, counts as one character] */
type Hidden = [number, number, boolean];

/** Is this paragraph inside a table cell (no headings there) */
const inCell = (doc: PMNode, pos: number) => /cell/.test(doc.resolve(pos).parent.type.spec.tableRole ?? "");
export const isSource = (n: PMNode) => n.type.name === "paragraph";

export const revealMeta = (tr: Transaction) => tr.setMeta(inlineKey, { reveal: true } satisfies Meta);
const toCaret = (view: EditorView, pos: number) => placeCaret(view, pos, revealMeta);

/**
 * Decorations (into `out`) and hidden ranges (into `hidden`) of one source paragraph at pos. head: the caret, when it
 * shows markers; expand: the image whose folded address is open
 */
function layout(node: PMNode, pos: number, cell: boolean, head: number | null, expand: number | null, out: Decoration[] | null, hidden: Hidden[] | null) {
  const text = node.textContent;
  if (!text) return;
  const info = blockInfo(text, !cell), base = pos + 1, end = base + text.length;
  const inBlock = head !== null && head >= base && head <= end;
  const hide = (a: number, b: number, atom: boolean) => { out?.push(Decoration.inline(a, b, { class: "md-hide" })); hidden?.push([a, b, atom]); };
  const mk = (a: number, b: number, on: boolean, cls = "") => {
    if (a >= b) return;
    out?.push(Decoration.inline(a, b, { class: `md-mk${cls}${on ? "" : " md-hide"}` }));
    if (!on) hidden?.push([a, b, false]);
  };
  if (info.prefix) mk(base, base + info.prefix, inBlock, " md-mkh");
  const walk = (spans: Span[], wrap: Tag[]) => {
    for (const sp of spans) {
      const from = base + sp.from, to = base + sp.to, act = inBlock && head! >= from && head! <= to;
      if (sp.plain) { out?.push(Decoration.inline(from, to, { class: "md-comment" })); continue; }
      const a = sp.atom;
      if (a) {
        const raw = text.slice(sp.from, sp.to);
        // a narrowed image is centred in its line: a class on the paragraph (markdown.css; a p:has() rule would be checked
        // again for every paragraph of the Note on each change)
        if (a.type === "image" && a.width) out?.push(Decoration.node(pos, pos + node.nodeSize, { class: "md-psized" }));
        if (!act) {
          hide(from, to, true);
          out?.push(Decoration.widget(from, atomWidget(a, raw, (f) => f + caretIn(sp), toCaret, wrap), {
            side: 1, key: `${a.type}:${raw}:${wrap.map((t) => t.nodeName).join()}`, stopEvent: (e) => a.type === "image" || e.type.startsWith("mouse"),
          }));
          continue;
        }
        if (a.type === "image") {
          mk(from, from + 2, true);
          if (a.altTo > sp.from + 2) out?.push(Decoration.inline(from + 2, base + a.altTo, { class: "md-imgalt" }));
          const fold = foldRange(a.url), open = expand === from;
          if (fold && !open) {
            mk(base + a.altTo, base + fold[0], true, " md-url");
            hide(base + fold[0], base + fold[1], false);
            out?.push(Decoration.widget(base + fold[0], ellipsis, { side: -1, key: "ell" }));
            mk(base + fold[1], to, true, " md-url");
          } else mk(base + a.altTo, to, true, " md-url");
          if (fold) out?.push(Decoration.widget(to, foldButton(open, (v) => v.dispatch(v.state.tr.setMeta(inlineKey, { expand: open ? null : from } satisfies Meta))), { side: 1, key: `fold:${open}`, ignoreSelection: true, stopEvent: () => true }));
          out?.push(Decoration.widget(to, imageBelow(a), { side: 2, key: `below:${raw}`, ignoreSelection: true, stopEvent: () => true }));
          continue;
        }
        if (a.type === "math") {
          out?.push(Decoration.inline(from, to, { class: "md-texsrc" }));
          if (a.display) out?.push(Decoration.widget(to, mathBelow(a.latex), { side: 2, key: `dmath:${a.latex}`, ignoreSelection: true, stopEvent: () => true }));
        }
        for (const [x, y] of sp.marks) mk(base + x, base + y, true);
        if (sp.inner && sp.tag && sp.inner[1] > sp.inner[0]) out?.push(Decoration.inline(base + sp.inner[0], base + sp.inner[1], { ...sp.tag }));
        if (a.type === "br") out?.push(Decoration.widget(to, atomWidget(a, raw, () => to, toCaret), { side: 1, key: "br", ignoreSelection: true }));
        continue;
      }
      if (sp.inner && sp.tag && sp.inner[1] > sp.inner[0]) out?.push(Decoration.inline(base + sp.inner[0], base + sp.inner[1], { ...sp.tag }));
      for (const [x, y] of sp.marks) mk(base + x, base + y, act, sp.tag?.nodeName === "a" && x > sp.inner![0] ? " md-url" : "");
      walk(sp.kids, sp.tag ? [...wrap, sp.tag] : wrap);
    }
  };
  walk(info.spans, []);
}

/** Where a click on a drawn atom puts the caret, from the start of its source */
function caretIn(sp: Span): number {
  switch (sp.atom?.type) {
    // at the end of the LaTeX, before the closing $: where one goes on typing
    case "math": return sp.marks.length > 1 ? sp.marks[sp.marks.length - 1][0] - sp.from : sp.to - sp.from - 1;
    case "image": case "ref": return 2;
    case "fn": case "html": return sp.to - sp.from;
    default: return 1;
  }
}

/** Decorations of every source paragraph between from and to */
function blocksIn(doc: PMNode, from: number, to: number, head: number | null, expand: number | null, out: Decoration[]) {
  doc.nodesBetween(from, to, (n, pos, parent) => {
    if (n.isTextblock) { if (isSource(n)) layout(n, pos, /cell/.test(parent?.type.spec.tableRole ?? ""), head, expand, out, null); return false; }
    return !n.type.spec.code && !n.isAtom;
  });
}
function build(doc: PMNode, head: number | null, expand: number | null) {
  const out: Decoration[] = [];
  blocksIn(doc, 0, doc.content.size, head, expand, out);
  return DecorationSet.create(doc, out);
}
/** The source paragraph that contains pos: [start, end] of its node, or null */
function blockAt(doc: PMNode, pos: number | null): [number, number] | null {
  if (pos === null || pos < 0 || pos > doc.content.size) return null;
  const $p = doc.resolve(pos);
  return $p.parent.isTextblock && isSource($p.parent) && $p.depth ? [$p.before(), $p.after()] : null;
}

/**
 * Only the paragraphs that changed, and the ones the caret left and entered, are laid out again: a long Note costs the
 * same per keystroke as a short one
 */
function update(prev: St, tr: Transaction, head: number | null, expand: number | null, doc: PMNode): DecorationSet {
  let set = tr.docChanged ? prev.decos.map(tr.mapping, doc) : prev.decos;
  const dirty: [number, number][] = [];
  if (tr.docChanged) {
    tr.mapping.maps.forEach((m, i) => m.forEach((_a, _b, s, e) => {
      const rest = tr.mapping.slice(i + 1);
      dirty.push([rest.map(s, -1), rest.map(e, 1)]);
    }));
  }
  const oldHead = prev.head === null ? null : tr.mapping.map(prev.head);
  if (oldHead !== head || prev.expand !== expand) {
    for (const p of [oldHead, head]) { const b = blockAt(doc, p); if (b) dirty.push(b); }
    if (prev.expand !== null) { const b = blockAt(doc, tr.mapping.map(prev.expand)); if (b) dirty.push(b); }
  }
  if (!dirty.length) return set;
  const blocks = new Map<number, PMNode>(), size = doc.content.size;
  for (const [a0, b0] of dirty) {
    const a = Math.max(0, Math.min(a0, size)), b = Math.max(a, Math.min(b0, size));
    doc.nodesBetween(a, Math.max(b, a + 1 <= size ? a + 1 : a), (n, pos) => {
      if (n.isTextblock) { if (isSource(n)) blocks.set(pos, n); return false; }
      return !n.type.spec.code && !n.isAtom;
    });
  }
  const out: Decoration[] = [];
  for (const [pos, n] of blocks) {
    // only this block's own decorations: find() also returns the ones that touch its edges, such as the previous or next
    // paragraph's node decoration (md-psized), which would be lost with the block's layout
    const end = pos + n.nodeSize;
    set = set.remove(set.find(pos, end).filter((d) => d.from >= pos && d.to <= end && d.to !== pos && d.from !== end));
    layout(n, pos, inCell(doc, pos), head, expand, out, null);
  }
  return set.add(doc, out);
}

/** Has the caret settled, so that markers may follow it */
const settled = (st: EditorState, focused: boolean) => st.selection.empty && focused && !ui.mouseDown && !ui.pending;

function reveal(view: EditorView) { if (!view.isDestroyed) view.dispatch(revealMeta(view.state.tr)); }

export function inlinePlugin() {
  return new Plugin<St>({
    key: inlineKey,
    state: {
      init: (_c, st) => ({ head: null, focused: false, expand: null, decos: build(st.doc, null, null) }),
      apply(tr, prev, _old, st) {
        const meta = (tr.getMeta(inlineKey) ?? {}) as Meta;
        const focused = meta.blur ? false : meta.focus || meta.reveal ? true : prev.focused;
        let expand = meta.expand !== undefined ? meta.expand : prev.expand === null ? null : tr.mapping.map(prev.expand);
        // While composing only map: never touch the DOM the IME is writing into
        if (ui.composing && !meta.reveal) return tr.docChanged ? { ...prev, head: prev.head === null ? null : tr.mapping.map(prev.head), expand, decos: prev.decos.map(tr.mapping, tr.doc) } : prev;
        let head: number | null;
        // a block selected as a whole (a formula block the arrow keys walked into, which then takes the keyboard): the caret has
        // left the text, so every source closes now, not when the blur that follows reaches here
        if (meta.blur || (st.selection instanceof NodeSelection && st.selection.node.isBlock)) head = null;
        else if (settled(st, focused) || (meta.reveal && st.selection.empty && !ui.mouseDown)) head = st.selection.head;
        else head = prev.head === null ? null : tr.mapping.map(prev.head);
        // the open address closes once the caret leaves its image
        if (expand !== null && head !== null) { const b = blockAt(st.doc, expand); if (!b || head < b[0] || head > b[1]) expand = null; }
        if (head === prev.head && !tr.docChanged && expand === prev.expand && focused === prev.focused) return prev;
        // the caret moving into or out of an image's source (not typing): the image is measured before the redraw, to slide
        if (head !== prev.head && !tr.docChanged && slideView) {
          const blocks = [prev.head, head].map((p) => blockAt(st.doc, p)?.[0]).filter((p): p is number => p !== undefined && /!\[/.test(st.doc.nodeAt(p)?.textContent ?? ""));
          if (blocks.length) slideFrom = measureImages(slideView, [...new Set(blocks)]);
        }
        return { head, focused, expand, decos: update(prev, tr, head, expand, st.doc) };
      },
    },
    props: {
      decorations: (st) => inlineKey.getState(st)!.decos,
      handleDOMEvents: {
        mousedown: (_v, e) => { if (e.button === 0) { ui.mouseDown = true; ui.pending = false; clearTimeout(ui.timer); } return false; },
        focus: (view) => { if (!ui.mouseDown) setTimeout(() => { if (view.hasFocus()) view.dispatch(view.state.tr.setMeta(inlineKey, { focus: true, reveal: true } satisfies Meta)); }); else view.dispatch(view.state.tr.setMeta(inlineKey, { focus: true } satisfies Meta)); return false; },
        blur: (view) => { setTimeout(() => { if (!view.isDestroyed && !view.hasFocus()) view.dispatch(view.state.tr.setMeta(inlineKey, { blur: true } satisfies Meta)); }); return false; },
        compositionstart: () => { ui.composing = true; return false; },
        compositionend: (view) => {
          ui.composing = false;
          const settle = () => (view.composing ? setTimeout(settle, 20) : reveal(view));
          setTimeout(settle, 0);
          return false;
        },
      },
      handleKeyDown(view, e) {
        // a key right after a click: show the markers first, then handle it on that layout
        if (ui.pending) { ui.pending = false; clearTimeout(ui.timer); reveal(view); }
        if (e.isComposing || e.keyCode === 229) return false;
        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.ctrlKey && !e.metaKey) return moveH(view, e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
        return false;
      },
    },
    view(view) {
      slideView = view;
      const up = () => {
        if (!ui.mouseDown) return;
        ui.mouseDown = false;
        if (view.isDestroyed || !view.state.selection.empty) return; // dragged out a selection: keep the layout
        ui.pending = true;
        clearTimeout(ui.timer);
        ui.timer = setTimeout(() => { ui.pending = false; reveal(view); }, REVEAL_AFTER_CLICK);
      };
      window.addEventListener("mouseup", up, true);
      return {
        update: (v) => { if (slideFrom) { const b = slideFrom; slideFrom = null; slideImages(v, b); } },
        destroy: () => { window.removeEventListener("mouseup", up, true); clearTimeout(ui.timer); ui.pending = false; ui.mouseDown = false; if (slideView === view) slideView = null; },
      };
    },
  });
}

/** Hidden ranges of the paragraph at $pos with the current layout */
function hiddenAt(state: EditorState, pos: number): Hidden[] {
  const $p = state.doc.resolve(pos), out: Hidden[] = [], st = inlineKey.getState(state)!;
  layout($p.parent, $p.before(), inCell(state.doc, $p.before()), st.head, st.expand, null, out);
  return out.sort((a, b) => a[0] - b[0]);
}
const hi = (c: number) => c >= 0xd800 && c <= 0xdbff, lo = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** ← →: a hidden run of markers is crossed in one press, a hidden atom (formula, image) counts as one character */
export function moveH(view: EditorView, dir: number, shift: boolean): boolean {
  const { state } = view, sel = state.selection;
  if (!(sel instanceof TextSelection)) return false;
  if (!shift && !sel.empty) {
    view.dispatch(revealMeta(state.tr.setSelection(TextSelection.create(state.doc, dir > 0 ? sel.to : sel.from))).scrollIntoView());
    return true;
  }
  const $h = sel.$head, block = $h.parent;
  if (!block.isTextblock || !isSource(block) || !$h.depth) return false;
  const base = $h.start(), end = $h.end(), text = block.textContent, hid = hiddenAt(state, sel.head);
  let q = sel.head;
  for (;;) {
    if (dir > 0 ? q >= end : q <= base) { if (q === sel.head) return false; break; }
    const r = hid.find(([a, b]) => (dir > 0 ? q >= a && q < b : q > a && q <= b));
    if (r) { q = dir > 0 ? r[1] : r[0]; if (r[2]) break; continue; }
    const i = q - base;
    if (dir > 0) q += hi(text.charCodeAt(i)) && lo(text.charCodeAt(i + 1)) ? 2 : 1;
    else q -= lo(text.charCodeAt(i - 1)) && hi(text.charCodeAt(i - 2)) ? 2 : 1;
    break;
  }
  const tr = state.tr.setSelection(shift ? TextSelection.create(state.doc, sel.anchor, q) : TextSelection.create(state.doc, q));
  view.dispatch((shift ? tr : revealMeta(tr)).scrollIntoView());
  return true;
}

/**
 * ⌘B and friends: add or remove the markers around the selection (the document is source, so this only inserts or
 * deletes characters). An empty selection inserts the pair and puts the caret between
 */
export function toggleWrap(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, open: string, close = open): boolean {
  const { from, to, $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock || $from.parent.type.spec.code) return false;
  const base = $from.start(), text = $from.parent.textContent, a = from - base, b = to - base, L = open.length, R = close.length;
  const tr = state.tr;
  // the caret at the end of a span this pair closes (typed ⌘B, the text, ⌘B): step out over the closing marker
  if (a === b && text.slice(b, b + R) === close && b > L) {
    const sp = flat(blockInfo(text, !inCell(state.doc, $from.before())).spans).find((x) => x.inner?.[1] === a && x.marks.some(([m0, m1]) => m0 === a && m1 === a + R) && text.slice(x.from, x.from + L) === open);
    if (sp) { dispatch?.(revealMeta(tr.setSelection(TextSelection.create(tr.doc, from + R)))); return true; }
  }
  if (text.slice(a - L, a) === open && text.slice(b, b + R) === close) {
    tr.delete(to, to + R).delete(from - L, from).setSelection(TextSelection.create(tr.doc, from - L, to - L));
  } else if (b - a >= L + R && text.slice(a, a + L) === open && text.slice(b - R, b) === close && b - a > L + R) {
    tr.delete(to - R, to).delete(from, from + L).setSelection(TextSelection.create(tr.doc, from, to - L - R));
  } else {
    // spans the selection only partly covers are taken in whole, so the new markers never interleave with theirs
    // (==note with **bold==** would not parse as either)
    let x = a, y = b;
    if (x < y) {
      const spans = flat(blockInfo(text, !inCell(state.doc, $from.before())).spans).filter((sp) => sp.atom || (sp.inner && sp.tag));
      for (let moved = true; moved;) {
        moved = false;
        for (const sp of spans) {
          const whole = !!sp.atom && sp.atom.type !== "annot";
          if (x > sp.from && x < sp.to && (y > sp.to || whole)) { x = sp.from; moved = true; }
          if (y > sp.from && y < sp.to && (x < sp.from || whole)) { y = sp.to; moved = true; }
        }
      }
    }
    const f = base + x, t = base + y;
    tr.insertText(close, t).insertText(open, f).setSelection(TextSelection.create(tr.doc, f + L, t + L));
  }
  dispatch?.(revealMeta(tr).scrollIntoView());
  return true;
}
/** Is the selection wrapped in open…close (for the toolbar's pressed state) */
export function isWrapped(state: EditorState, open: string, close = open): boolean {
  const { from, to, $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
  const base = $from.start(), text = $from.parent.textContent, a = from - base, b = to - base;
  return (text.slice(a - open.length, a) === open && text.slice(b, b + close.length) === close)
    || (b - a > open.length + close.length && text.slice(a, a + open.length) === open && text.slice(b - close.length, b) === close);
}

/** Paragraphs render as h1–h6 when their source starts with `#`s (never in a table cell) */
export class ParaView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private tag: string;
  private cell: boolean;
  constructor(private node: PMNode, view: EditorView, getPos: () => number | undefined) {
    const pos = getPos();
    this.cell = pos != null && inCell(view.state.doc, pos);
    this.tag = tagOf(node, this.cell);
    this.dom = this.contentDOM = document.createElement(this.tag);
  }
  update(n: PMNode) {
    if (n.type !== this.node.type || tagOf(n, this.cell) !== this.tag) return false;
    this.node = n;
    return true;
  }
}
const tagOf = (n: PMNode, cell: boolean) => { const l = cell ? 0 : blockInfo(n.textContent, true).level; return l ? `h${l}` : "p"; };
