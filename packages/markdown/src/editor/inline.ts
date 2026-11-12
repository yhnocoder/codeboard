// Paragraphs, headings and table-cell paragraphs hold their Markdown source as plain text. This plugin only draws it:
// formatting comes from the parser (spans.ts) as decorations, and the markers (`**`, `](url)`) show only where
// the caret is. Moving the caret never changes the document. The decorations stay frozen while the mouse is down, while
// a selection is non-empty, during IME composition and for a moment after a single click (a double-click must land on
// the same layout as the first click).
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { REVEAL_AFTER_CLICK } from "../ui/timing";
import { blockInfo, flat, type Span } from "./spans";
import {
  atomWidget,
  DRAG_START,
  ellipsis,
  foldButton,
  foldRange,
  imageBelow,
  imageViews,
  mathBelow,
  placeCaret,
  urlChip,
  bareLink,
  type CaptionHit,
} from "./widgets";
import { bareSpan, LONG_URL, shortUrl } from "./links";
import { measureImages, slideImages } from "./imageslide";

type Tag = NonNullable<Span["tag"]>;

/** open: the image whose source is open (where it starts); picked: the selected image (its source selected exactly) */
type St = {
  head: number | null;
  focused: boolean;
  expand: number | null;
  open: number | null;
  picked: number | null;
  decos: DecorationSet;
};
type Meta = { reveal?: true; blur?: true; focus?: true; expand?: number | null; open?: number | null };
export const inlineKey = new PluginKey<St>("cbInline");

/** Input state shared by the plugin's handlers (only one editor takes input at a time) */
const ui = { mouseDown: false, pending: false, composing: false, timer: 0 as ReturnType<typeof setTimeout> | 0 };
/** The editor whose images slide (one editor is open at a time), and what was measured before the redraw (imageslide.ts) */
let slideView: EditorView | null = null,
  slideFrom: ReturnType<typeof measureImages> | null = null;

/** A range the caret crosses in one step: [from, to, counts as one character] */
type Hidden = [number, number, boolean];

/** Is this paragraph inside a table cell (no headings there) */
const inCell = (doc: PMNode, pos: number) => /cell/.test(doc.resolve(pos).parent.type.spec.tableRole ?? "");
const isSource = (n: PMNode) => n.type.name === "paragraph";

export const revealMeta = (tr: Transaction) => tr.setMeta(inlineKey, { reveal: true } satisfies Meta);
const toCaret = (view: EditorView, pos: number) => placeCaret(view, pos, revealMeta);

/**
 * Decorations (into `out`) and hidden ranges (into `hidden`) of one source paragraph at pos. head: the caret, when it
 * shows markers; expand: the image whose folded address is open
 */
function layout(
  node: PMNode,
  pos: number,
  top: boolean,
  head: number | null,
  expand: number | null,
  open: number | null,
  out: Decoration[] | null,
  hidden: Hidden[] | null,
) {
  const text = node.textContent;
  if (!text) return;
  const info = blockInfo(text),
    base = pos + 1,
    end = base + text.length;
  const inBlock = head !== null && head >= base && head <= end;
  const hide = (a: number, b: number, atom: boolean) => {
    out?.push(Decoration.inline(a, b, { class: "md-hide" }));
    hidden?.push([a, b, atom]);
  };
  const mk = (a: number, b: number, on: boolean, cls = "") => {
    if (a >= b) return;
    out?.push(Decoration.inline(a, b, { class: `md-mk${cls}${on ? "" : " md-hide"}` }));
    if (!on) hidden?.push([a, b, false]);
  };
  // an image alone in its paragraph, or a narrowed one, is centred in its line: a class on the paragraph (markdown.css; a
  // p:has() rule would be checked again for every paragraph of the Note on each change)
  if (out && centred(text, info.spans, top))
    out.push(Decoration.node(pos, pos + node.nodeSize, { class: "md-psized" }));
  const walk = (spans: Span[], wrap: Tag[]) => {
    for (const sp of spans) {
      const from = base + sp.from,
        to = base + sp.to,
        // an image's source opens only when asked to (open), or when the caret is inside it (typed or undone into it): with the
        // caret beside it, it is drawn and ← → step over it whole
        act =
          sp.atom?.type === "image"
            ? open === from || (inBlock && head! > from && head! < to)
            : inBlock && head! >= from && head! <= to;
      if (sp.plain) {
        out?.push(Decoration.inline(from, to, { class: "md-comment" }));
        continue;
      }
      const a = sp.atom;
      if (a) {
        const raw = text.slice(sp.from, sp.to);
        if (!act) {
          hide(from, to, true);
          out?.push(
            Decoration.widget(
              from,
              atomWidget(a, raw, (f) => f + caretIn(sp), toCaret, wrap, imageClick),
              {
                side: 1,
                key: `${a.type}:${raw}:${wrap.map((t) => t.nodeName).join()}`,
                stopEvent: (e) => a.type === "image" || e.type.startsWith("mouse"),
              },
            ),
          );
          continue;
        }
        if (a.type === "image") {
          mk(from, from + 2, true);
          if (a.altTo > sp.from + 2) out?.push(Decoration.inline(from + 2, base + a.altTo, { class: "md-imgalt" }));
          const fold = foldRange(a.url),
            open = expand === from;
          if (fold && !open) {
            mk(base + a.altTo, base + fold[0], true, " md-url");
            hide(base + fold[0], base + fold[1], false);
            out?.push(Decoration.widget(base + fold[0], ellipsis, { side: -1, key: "ell" }));
            mk(base + fold[1], to, true, " md-url");
          } else mk(base + a.altTo, to, true, " md-url");
          if (fold)
            out?.push(
              Decoration.widget(
                to,
                foldButton(open, (v) =>
                  v.dispatch(v.state.tr.setMeta(inlineKey, { expand: open ? null : from } satisfies Meta)),
                ),
                { side: 1, key: `fold:${open}`, ignoreSelection: true, stopEvent: () => true },
              ),
            );
          out?.push(
            Decoration.widget(to, imageBelow(a), {
              side: 2,
              key: `below:${raw}`,
              ignoreSelection: true,
              stopEvent: () => true,
            }),
          );
          continue;
        }
        if (a.type === "math") {
          out?.push(Decoration.inline(from, to, { class: "md-texsrc" }));
          if (a.display)
            out?.push(
              Decoration.widget(to, mathBelow(a.latex), {
                side: 2,
                key: `dmath:${a.latex}`,
                ignoreSelection: true,
                stopEvent: () => true,
              }),
            );
        }
        for (const [x, y] of sp.marks) mk(base + x, base + y, true);
        if (sp.inner && sp.tag && sp.inner[1] > sp.inner[0])
          out?.push(Decoration.inline(base + sp.inner[0], base + sp.inner[1], { ...sp.tag }));
        if (a.type === "br")
          out?.push(
            Decoration.widget(
              to,
              atomWidget(a, raw, () => to, toCaret),
              { side: 1, key: "br", ignoreSelection: true },
            ),
          );
        continue;
      }
      const href = String(sp.tag?.href ?? "");
      // a long address written as it is, away from the caret: its site, drawn as the link (it steps as one character)
      if (!act && href && bareSpan(sp) && to - from > LONG_URL) {
        hide(from, to, true);
        out?.push(Decoration.widget(from, bareLink(href, shortUrl(href)), { side: 1, key: `bare:${href}` }));
        continue;
      }
      if (sp.inner && sp.tag && sp.inner[1] > sp.inner[0])
        out?.push(Decoration.inline(base + sp.inner[0], base + sp.inner[1], { ...sp.tag }));
      // [text](url) with the caret in its text: the address stays folded to its site (a chip that opens the link's box);
      // it is written out only while the caret is inside it
      const tail = sp.tag?.nodeName === "a" && sp.marks.length === 2 ? sp.marks[1] : null,
        fold =
          act &&
          href &&
          tail &&
          text.startsWith("](", tail[0]) &&
          !(head! > base + tail[0] + 1 && head! < base + tail[1]);
      if (fold && tail) {
        mk(base + sp.marks[0][0], base + sp.marks[0][1], true);
        mk(base + tail[0], base + tail[0] + 1, true);
        hide(base + tail[0] + 1, base + tail[1], true);
        out?.push(Decoration.widget(base + tail[0] + 1, urlChip(shortUrl(href)), { side: 1, key: `chip:${href}` }));
      } else
        for (const [x, y] of sp.marks)
          mk(base + x, base + y, act, sp.tag?.nodeName === "a" && x > sp.inner![0] ? " md-url" : "");
      walk(sp.kids, sp.tag ? [...wrap, sp.tag] : wrap);
    }
  };
  walk(info.spans, []);
}

/** Where a click on a drawn atom puts the caret, from the start of its source */
function caretIn(sp: Span): number {
  switch (sp.atom?.type) {
    // at the end of the LaTeX, before the closing $: where one goes on typing
    case "math":
      return sp.marks.length > 1 ? sp.marks[sp.marks.length - 1][0] - sp.from : sp.to - sp.from - 1;
    case "ref":
      return 2;
    case "fn":
    case "html":
      return sp.to - sp.from;
    default:
      return 1;
  }
}

/** A paragraph drawn centred: one holding an image narrowed to a width, or (top: one of the Note's own, not in a list or a
 *  cell) only an image; as the static render (render.ts) */
function centred(text: string, spans: Span[], top: boolean): boolean {
  const imgs = spans.filter((sp) => sp.atom?.type === "image");
  if (imgs.some((sp) => sp.atom?.type === "image" && sp.atom.width)) return true;
  return top && imgs.length === 1 && !text.slice(0, imgs[0].from).trim() && !text.slice(imgs[0].to).trim();
}

/** The image whose source starts at `from`, as [from, to] in the document, if `at` (default: from) is within it */
function imageSpanAt(doc: PMNode, from: number, at = from): [number, number] | null {
  if (from < 0 || from > doc.content.size) return null;
  const $p = doc.resolve(from);
  if (!$p.parent.isTextblock || !isSource($p.parent) || !$p.depth) return null;
  const base = $p.start(),
    sp = flat(blockInfo($p.parent.textContent).spans).find((x) => x.atom?.type === "image" && base + x.from === from);
  return sp && at >= base + sp.from && at <= base + sp.to ? [base + sp.from, base + sp.to] : null;
}
/** The selected image: the selection covers exactly one image's source */
function pickedImage(state: EditorState): [number, number] | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return null;
  const r = imageSpanAt(state.doc, sel.from);
  return r && r[1] === sel.to ? r : null;
}

const pickImage = (view: EditorView, r: [number, number]) => {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, r[0], r[1])));
  view.focus();
};
/** Opens the image's source, the caret after its "![" or, for a press on its caption, at that character of the caption */
function openImage(view: EditorView, r: [number, number], cap: CaptionHit | null = null) {
  const doc = view.state.doc,
    at = (cap && captionPos(doc.textBetween(r[0], r[1]), cap)) ?? 2;
  const tr = view.state.tr.setSelection(TextSelection.create(doc, r[0] + at));
  view.dispatch(tr.setMeta(inlineKey, { open: r[0], reveal: true } satisfies Meta).scrollIntoView());
  view.focus();
}
/** A press on a drawn image: the first selects it, the next (or a double-click) opens its source */
function imageClick(view: EditorView, from: number, open: boolean, cap: CaptionHit | null) {
  const r = imageSpanAt(view.state.doc, from);
  if (!r) return;
  if (open) openImage(view, r, cap);
  else pickImage(view, r);
}

/** Where in an image's source (raw) the character cap.at of its drawn caption is: the caption is the title, between quotes,
 *  rendered (markers gone), so the drawn characters are matched to the source's in order */
function captionPos(raw: string, cap: CaptionHit): number | null {
  const m = /^!\[(?:\\.|[^\]\\])*\]\(\s*(?:<[^>]*>|(?:\\.|[^\s\\])+?)\s+(["'(])\s*/.exec(raw);
  if (!m) return null;
  let j = m[0].length,
    i = 0;
  const close = m[1] === "(" ? ")" : m[1],
    end = raw.lastIndexOf(close);
  while (i < cap.at && j < end) {
    if (raw[j] === cap.text[i]) i++;
    j++;
  }
  return j;
}

/** Selects the drawn image at the client point x, y (the click that starts the editing was on it); false if none is there */
export function pickImageAt(view: EditorView, x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y)?.closest(".md-img:not(.below)"),
    from = el && view.dom.contains(el) ? imageViews.get(el)?.() : undefined,
    r = from == null ? null : imageSpanAt(view.state.doc, from);
  if (r) pickImage(view, r);
  return !!r;
}

/** The keys of a selected image (⌫ / Delete remove it, ↵ opens its source, a typed character goes after it), and ⌫ / Delete
 *  beside a drawn image, which select it first */
function imageKey(view: EditorView, e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const { state } = view,
    pick = pickedImage(state);
  const del = e.key === "Backspace" || e.key === "Delete";
  if (pick) {
    if (del) {
      deleteImage(view, pick);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      openImage(view, pick);
      return true;
    }
    if (e.key.length === 1) view.dispatch(revealMeta(state.tr.setSelection(TextSelection.create(state.doc, pick[1]))));
    return false;
  }
  const sel = state.selection;
  if (!del || e.shiftKey || !(sel instanceof TextSelection) || !sel.empty) return false;
  const $h = sel.$head;
  if (!$h.parent.isTextblock || !isSource($h.parent) || !$h.depth) return false;
  const base = $h.start(),
    off = $h.parentOffset,
    open = inlineKey.getState(state)!.open;
  const sp = flat(blockInfo($h.parent.textContent).spans).find(
    (x) => x.atom?.type === "image" && (e.key === "Backspace" ? x.to === off : x.from === off),
  );
  if (!sp || open === base + sp.from) return false;
  pickImage(view, [base + sp.from, base + sp.to]);
  return true;
}

/** Takes a selected image out with a space beside it; a paragraph left empty goes too, the caret at the end of the one before */
function deleteImage(view: EditorView, [from, to]: [number, number]) {
  const { state } = view,
    $f = state.doc.resolve(from),
    p = $f.parent,
    text = p.textContent,
    a = from - $f.start(),
    b = to - $f.start();
  let x = from,
    y = to;
  if (text[b] === " " && (a === 0 || text[a - 1] === " ")) y++;
  else if (a > 0 && text[a - 1] === " " && b === text.length) x--;
  const tr = state.tr;
  if (y - x === text.length && $f.node(-1).childCount > 1) {
    tr.delete($f.before(), $f.after());
    const $at = tr.doc.resolve(Math.min(tr.mapping.map($f.before()), tr.doc.content.size));
    tr.setSelection($f.index(-1) > 0 ? Selection.near($at, -1) : Selection.near($at, 1));
  } else tr.delete(x, y);
  view.dispatch(revealMeta(tr).scrollIntoView());
}

/** The selected image's drawn element carries md-picked (its ring and resize grips); widgets keep their DOM across redraws */
function markPicked(view: EditorView, at: number | null) {
  for (const el of view.dom.querySelectorAll<HTMLElement>(".md-img:not(.below)")) {
    const pos = imageViews.get(el)?.();
    el.classList.toggle("md-picked", at !== null && pos === at);
  }
}

/** Decorations of every source paragraph between from and to */
function blocksIn(
  doc: PMNode,
  from: number,
  to: number,
  head: number | null,
  expand: number | null,
  out: Decoration[],
) {
  doc.nodesBetween(from, to, (n, pos, parent) => {
    if (n.isTextblock) {
      if (isSource(n)) layout(n, pos, parent === doc, head, expand, null, out, null);
      return false;
    }
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
function update(
  prev: St,
  tr: Transaction,
  head: number | null,
  expand: number | null,
  open: number | null,
  doc: PMNode,
): DecorationSet {
  let set = tr.docChanged ? prev.decos.map(tr.mapping, doc) : prev.decos;
  const dirty: [number, number][] = [];
  if (tr.docChanged) {
    tr.mapping.maps.forEach((m, i) =>
      m.forEach((_a, _b, s, e) => {
        const rest = tr.mapping.slice(i + 1);
        dirty.push([rest.map(s, -1), rest.map(e, 1)]);
      }),
    );
  }
  const oldHead = prev.head === null ? null : tr.mapping.map(prev.head);
  const oldOpen = prev.open === null ? null : tr.mapping.map(prev.open);
  if (oldHead !== head || prev.expand !== expand || oldOpen !== open) {
    for (const p of [oldHead, head, oldOpen, open]) {
      const b = blockAt(doc, p);
      if (b) dirty.push(b);
    }
    if (prev.expand !== null) {
      const b = blockAt(doc, tr.mapping.map(prev.expand));
      if (b) dirty.push(b);
    }
  }
  if (!dirty.length) return set;
  const blocks = new Map<number, PMNode>(),
    size = doc.content.size;
  for (const [a0, b0] of dirty) {
    const a = Math.max(0, Math.min(a0, size)),
      b = Math.max(a, Math.min(b0, size));
    doc.nodesBetween(a, Math.max(b, a + 1 <= size ? a + 1 : a), (n, pos) => {
      if (n.isTextblock) {
        if (isSource(n)) blocks.set(pos, n);
        return false;
      }
      return !n.type.spec.code && !n.isAtom;
    });
  }
  const out: Decoration[] = [];
  for (const [pos, n] of blocks) {
    // only this block's own decorations: find() also returns the ones that touch its edges, such as the previous or next
    // paragraph's node decoration (md-psized), which would be lost with the block's layout
    const end = pos + n.nodeSize;
    set = set.remove(set.find(pos, end).filter((d) => d.from >= pos && d.to <= end && d.to !== pos && d.from !== end));
    layout(n, pos, doc.resolve(pos).depth === 0, head, expand, open, out, null);
  }
  return set.add(doc, out);
}

/** Has the caret settled, so that markers may follow it */
const settled = (st: EditorState, focused: boolean) => st.selection.empty && focused && !ui.mouseDown && !ui.pending;

function reveal(view: EditorView) {
  if (!view.isDestroyed) view.dispatch(revealMeta(view.state.tr));
}

export function inlinePlugin() {
  return new Plugin<St>({
    key: inlineKey,
    state: {
      init: (_c, st) => ({
        head: null,
        focused: false,
        expand: null,
        open: null,
        picked: null,
        decos: build(st.doc, null, null),
      }),
      apply(tr, prev, _old, st) {
        const meta = (tr.getMeta(inlineKey) ?? {}) as Meta;
        const focused = meta.blur ? false : meta.focus || meta.reveal ? true : prev.focused;
        let expand =
          meta.expand !== undefined ? meta.expand : prev.expand === null ? null : tr.mapping.map(prev.expand);
        let open = meta.open !== undefined ? meta.open : prev.open === null ? null : tr.mapping.map(prev.open);
        const pick = tr.getMeta(DRAG_START) ? null : pickedImage(st),
          picked = pick ? pick[0] : null;
        // While composing only map: never touch the DOM the IME is writing into
        if (ui.composing && !meta.reveal)
          return tr.docChanged
            ? {
                ...prev,
                head: prev.head === null ? null : tr.mapping.map(prev.head),
                expand,
                open,
                picked,
                decos: prev.decos.map(tr.mapping, tr.doc),
              }
            : prev;
        let head: number | null;
        // a block selected as a whole (a formula block the arrow keys walked into, which then takes the keyboard): the caret has
        // left the text, so every source closes now, not when the blur that follows reaches here
        if (meta.blur || (st.selection instanceof NodeSelection && st.selection.node.isBlock)) head = null;
        // a selected image: drawn with its ring, every source around it closed
        else if (pick) head = null;
        else if (settled(st, focused) || (meta.reveal && st.selection.empty && !ui.mouseDown)) head = st.selection.head;
        else head = prev.head === null ? null : tr.mapping.map(prev.head);
        // the open address closes once the caret leaves its image
        if (expand !== null && head !== null) {
          const b = blockAt(st.doc, expand);
          if (!b || head < b[0] || head > b[1]) expand = null;
        }
        // the open source closes once the caret leaves its image, or another is selected
        if (open !== null && (pick || (head !== null && !imageSpanAt(st.doc, open, head)))) open = null;
        if (
          head === prev.head &&
          !tr.docChanged &&
          expand === prev.expand &&
          focused === prev.focused &&
          open === prev.open &&
          picked === prev.picked
        )
          return prev;
        // the caret moving into or out of an image's source (not typing): the image is measured before the redraw, to slide
        if ((head !== prev.head || open !== prev.open) && !tr.docChanged && slideView) {
          const blocks = [prev.head, head, prev.open, open]
            .map((p) => blockAt(st.doc, p)?.[0])
            .filter((p): p is number => p !== undefined && /!\[/.test(st.doc.nodeAt(p)?.textContent ?? ""));
          if (blocks.length) slideFrom = measureImages(slideView, [...new Set(blocks)]);
        }
        return { head, focused, expand, open, picked, decos: update(prev, tr, head, expand, open, st.doc) };
      },
    },
    props: {
      decorations: (st) => inlineKey.getState(st)!.decos,
      handleDOMEvents: {
        mousedown: (_v, e) => {
          if (e.button === 0) {
            ui.mouseDown = true;
            ui.pending = false;
            clearTimeout(ui.timer);
          }
          return false;
        },
        focus: (view) => {
          if (!ui.mouseDown)
            setTimeout(() => {
              if (view.hasFocus())
                view.dispatch(view.state.tr.setMeta(inlineKey, { focus: true, reveal: true } satisfies Meta));
            });
          else view.dispatch(view.state.tr.setMeta(inlineKey, { focus: true } satisfies Meta));
          return false;
        },
        blur: (view) => {
          setTimeout(() => {
            if (!view.isDestroyed && !view.hasFocus())
              view.dispatch(view.state.tr.setMeta(inlineKey, { blur: true } satisfies Meta));
          });
          return false;
        },
        compositionstart: () => {
          ui.composing = true;
          return false;
        },
        compositionend: (view) => {
          ui.composing = false;
          const settle = () => (view.composing ? setTimeout(settle, 20) : reveal(view));
          setTimeout(settle, 0);
          return false;
        },
      },
      handleKeyDown(view, e) {
        // a key right after a click: show the markers first, then handle it on that layout
        if (ui.pending) {
          ui.pending = false;
          clearTimeout(ui.timer);
          reveal(view);
        }
        if (e.isComposing || e.keyCode === 229) return false;
        // a key before the focus handler's timer has run (typed at once after the editor got focus, on a busy page): the
        // editor has the keyboard, so the markers follow the caret from this key on. Otherwise they stay hidden, and the
        // browser puts what is typed after a hidden closing ** before it, into the bold
        if (!ui.composing && !inlineKey.getState(view.state)!.focused && view.hasFocus()) reveal(view);
        if (imageKey(view, e)) return true;
        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.ctrlKey && !e.metaKey)
          return moveH(view, e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
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
        ui.timer = setTimeout(() => {
          ui.pending = false;
          reveal(view);
        }, REVEAL_AFTER_CLICK);
      };
      window.addEventListener("mouseup", up, true);
      return {
        update: (v, old) => {
          const now = inlineKey.getState(v.state)!.picked;
          if (now !== null || inlineKey.getState(old)!.picked !== null) markPicked(v, now);
          if (slideFrom) {
            const b = slideFrom;
            slideFrom = null;
            slideImages(v, b);
          }
        },
        destroy: () => {
          window.removeEventListener("mouseup", up, true);
          clearTimeout(ui.timer);
          ui.pending = false;
          ui.mouseDown = false;
          if (slideView === view) slideView = null;
        },
      };
    },
  });
}

/** Hidden ranges of the paragraph at $pos with the current layout */
function hiddenAt(state: EditorState, pos: number): Hidden[] {
  const $p = state.doc.resolve(pos),
    out: Hidden[] = [],
    st = inlineKey.getState(state)!;
  layout($p.parent, $p.before(), false, st.head, st.expand, st.open, null, out);
  return out.sort((a, b) => a[0] - b[0]);
}
const hi = (c: number) => c >= 0xd800 && c <= 0xdbff,
  lo = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** ← →: a hidden run of markers is crossed in one press, a hidden atom (formula, image) counts as one character */
function moveH(view: EditorView, dir: number, shift: boolean): boolean {
  const { state } = view,
    sel = state.selection;
  if (!(sel instanceof TextSelection)) return false;
  if (!shift && !sel.empty) {
    view.dispatch(
      revealMeta(state.tr.setSelection(TextSelection.create(state.doc, dir > 0 ? sel.to : sel.from))).scrollIntoView(),
    );
    return true;
  }
  const $h = sel.$head,
    block = $h.parent;
  if (!block.isTextblock || !isSource(block) || !$h.depth) return false;
  const base = $h.start(),
    end = $h.end(),
    text = block.textContent,
    hid = hiddenAt(state, sel.head);
  let q = sel.head;
  for (;;) {
    if (dir > 0 ? q >= end : q <= base) {
      if (q === sel.head) return false;
      break;
    }
    const r = hid.find(([a, b]) => (dir > 0 ? q >= a && q < b : q > a && q <= b));
    if (r) {
      q = dir > 0 ? r[1] : r[0];
      if (r[2]) break;
      continue;
    }
    const i = q - base;
    if (dir > 0) q += hi(text.charCodeAt(i)) && lo(text.charCodeAt(i + 1)) ? 2 : 1;
    else q -= lo(text.charCodeAt(i - 1)) && hi(text.charCodeAt(i - 2)) ? 2 : 1;
    break;
  }
  const tr = state.tr.setSelection(
    shift ? TextSelection.create(state.doc, sel.anchor, q) : TextSelection.create(state.doc, q),
  );
  view.dispatch((shift ? tr : revealMeta(tr)).scrollIntoView());
  return true;
}

/** Spans that [x, y) of a paragraph's source only partly covers, taken in whole, so new markers never interleave with
 *  theirs (==note with **bold==** would not parse as either) */
function spanSafe(text: string, x: number, y: number): [number, number] {
  if (x >= y) return [x, y];
  const spans = flat(blockInfo(text).spans).filter((sp) => sp.atom || (sp.inner && sp.tag));
  for (let moved = true; moved; ) {
    moved = false;
    for (const sp of spans) {
      const whole = !!sp.atom && sp.atom.type !== "annot";
      if (x > sp.from && x < sp.to && (y > sp.to || whole)) {
        x = sp.from;
        moved = true;
      }
      if (y > sp.from && y < sp.to && (x < sp.from || whole)) {
        y = sp.to;
        moved = true;
      }
    }
  }
  return [x, y];
}

/**
 * ⌘B and friends: add or remove the markers around the selection (the document is source, so this only inserts or
 * deletes characters). An empty selection inserts the pair and puts the caret between
 */
export function toggleWrap(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  open: string,
  close = open,
): boolean {
  const { from, to, $from, $to } = state.selection;
  if ($from.sameParent($to) && $from.parent.type.spec.code) return false;
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return wrapEach(state, dispatch, open, close);
  const base = $from.start(),
    text = $from.parent.textContent,
    a = from - base,
    b = to - base,
    L = open.length,
    R = close.length;
  const tr = state.tr;
  // the caret at the end of a span this pair closes (typed ⌘B, the text, ⌘B): step out over the closing marker
  if (a === b && text.slice(b, b + R) === close && b > L) {
    const sp = flat(blockInfo(text).spans).find(
      (x) =>
        x.inner?.[1] === a &&
        x.marks.some(([m0, m1]) => m0 === a && m1 === a + R) &&
        text.slice(x.from, x.from + L) === open,
    );
    if (sp) {
      dispatch?.(revealMeta(tr.setSelection(TextSelection.create(tr.doc, from + R))));
      return true;
    }
  }
  if (text.slice(a - L, a) === open && text.slice(b, b + R) === close) {
    tr.delete(to, to + R)
      .delete(from - L, from)
      .setSelection(TextSelection.create(tr.doc, from - L, to - L));
  } else if (b - a >= L + R && text.slice(a, a + L) === open && text.slice(b - R, b) === close && b - a > L + R) {
    tr.delete(to - R, to)
      .delete(from, from + L)
      .setSelection(TextSelection.create(tr.doc, from, to - L - R));
  } else {
    const [x, y] = spanSafe(text, a, b);
    const f = base + x,
      t = base + y;
    tr.insertText(close, t)
      .insertText(open, f)
      .setSelection(TextSelection.create(tr.doc, f + L, t + L));
  }
  dispatch?.(revealMeta(tr).scrollIntoView());
  return true;
}
/**
 * A selection over several paragraphs: markers cannot span a paragraph break, so each paragraph's selected words are
 * wrapped on their own (spaces at the ends left outside); when every part already is wrapped in the pair, all are
 * unwrapped
 */
function wrapEach(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  open: string,
  close: string,
): boolean {
  const { from, to } = state.selection;
  const parts: { base: number; text: string; x: number; y: number }[] = [];
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (!n.isTextblock) return !n.type.spec.code && !n.isAtom;
    if (!isSource(n)) return false;
    const base = pos + 1,
      text = n.textContent;
    let x = Math.max(from, base) - base,
      y = Math.min(to, base + text.length) - base;
    while (x < y && /\s/.test(text[x])) x++;
    while (y > x && /\s/.test(text[y - 1])) y--;
    if (x < y) parts.push({ base, text, x, y });
    return false;
  });
  if (!parts.length) return false;
  const L = open.length,
    R = close.length;
  // where a part's markers are: each just outside it or the first / last characters it took in (-1: none)
  const markers = (p: (typeof parts)[0]): [number, number] | null => {
    const o = p.text.slice(p.x - L, p.x) === open ? p.x - L : p.text.slice(p.x, p.x + L) === open ? p.x : -1,
      c = p.text.slice(p.y, p.y + R) === close ? p.y : p.text.slice(p.y - R, p.y) === close ? p.y - R : -1;
    return o >= 0 && c > o + L ? [o, c] : null;
  };
  const wrapped = parts.every((p) => markers(p));
  const tr = state.tr;
  // from the last part back, so the earlier positions still hold
  for (const p of [...parts].reverse()) {
    if (wrapped) {
      const [o, c] = markers(p)!;
      tr.delete(p.base + c, p.base + c + R).delete(p.base + o, p.base + o + L);
    } else {
      const [x, y] = spanSafe(p.text, p.x, p.y);
      tr.insertText(close, p.base + y).insertText(open, p.base + x);
    }
  }
  tr.setSelection(
    TextSelection.between(tr.doc.resolve(tr.mapping.map(from, 1)), tr.doc.resolve(tr.mapping.map(to, -1))),
  );
  dispatch?.(revealMeta(tr).scrollIntoView());
  return true;
}

/** Is the selection wrapped in open…close (for the toolbar's pressed state) */
export function isWrapped(state: EditorState, open: string, close = open): boolean {
  const { from, to, $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
  const base = $from.start(),
    text = $from.parent.textContent,
    a = from - base,
    b = to - base;
  return (
    (text.slice(a - open.length, a) === open && text.slice(b, b + close.length) === close) ||
    (b - a > open.length + close.length &&
      text.slice(a, a + open.length) === open &&
      text.slice(b - close.length, b) === close)
  );
}

/** Paragraphs render as h1–h6 when they have a level (never in a table cell) */
export class ParaView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private tag: string;
  private cell: boolean;
  constructor(
    private node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ) {
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
export const tagOf = (n: PMNode, cell: boolean) => {
  const l: number = cell ? 0 : n.attrs.level;
  return l ? `h${l}` : "p";
};
