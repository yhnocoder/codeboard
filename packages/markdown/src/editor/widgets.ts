// What the editor draws for inline source it hides: formulas, images, line breaks and the rest. Each builder returns a
// widget toDOM function; the source text stays in the document and these elements are never part of it.
import katex from "katex";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { markTex, type MathPreamble } from "../math";
import { captionOf, missingImage, IMAGE_DRAG_TYPE, type DraggedImage } from "../image";
import { captionHtml } from "../render";
import type { Md } from "../markdown";
import { imageAttrsText } from "../imageattrs";
import { mdOf } from "./md";
import { IMAGE_SETTLE } from "../ui/timing";
import { blockInfo, flat, type Atom, type Span } from "./spans";
import { checkMath, problemBox } from "./mathhints";
import { DRAGGED_OUT } from "./image";
import { measureImages, slideImages } from "./imageslide";

type Tag = NonNullable<Span["tag"]>;

type ToDOM = (view: EditorView, getPos: () => number | undefined) => HTMLElement;

/** Puts the caret at pos and shows the source there right away (a click on a drawn thing means "edit this") */
export function placeCaret(view: EditorView, pos: number, meta: (tr: import("@tiptap/pm/state").Transaction) => void) {
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos));
  meta(tr);
  view.dispatch(tr);
  view.focus();
}

const span = (cls: string) => {
  const e = document.createElement("span");
  e.className = cls;
  e.contentEditable = "false";
  return e;
};

/** HTML only, as in the static render: MathML on the page turns on Chrome's MathML stylesheet, whose :nth-child rules make
 *  every inserted paragraph restyle all the blocks after it (Enter in a long Note took 150–200 ms) */
function renderTex(el: HTMLElement, latex: string, display: boolean, math: MathPreamble) {
  try {
    katex.render(latex, el, { displayMode: display, throwOnError: false, output: "html", macros: math.macrosCopy() });
    markTex(el, latex);
  } catch {
    el.textContent = latex;
  }
}

/** The static render of a piece of inline Markdown (emoji, [[ref]], {text|note}, inline HTML): same DOM as outside the editor */
function staticInline(raw: string, md: Md): string {
  const h = md.render(raw).trim();
  return h.startsWith("<p>") && h.endsWith("</p>") ? h.slice(3, -4) : h;
}

/** What a press on a drawn image does: open its source (a second click, or a click on an image already selected), else select
 *  it. cap: where in its caption it was clicked (the rendered caption's text and the offset in it), for the caret in the source */
export type ImageClick = (view: EditorView, from: number, open: boolean, cap: CaptionHit | null) => void;
export type CaptionHit = { text: string; at: number };

/**
 * The drawn form of a hidden atom, at the start of its source. A press puts the caret into the source (caret(from)),
 * which then shows; an image is selected or opened (onImage) and can also be dragged, which moves its source.
 * wrap: the formatting the atom sits in, outermost first (a widget is not inside the inline decorations around it)
 */
export function atomWidget(
  a: Atom,
  raw: string,
  caret: (from: number) => number,
  onCaret: (view: EditorView, pos: number) => void,
  wrap: Tag[] = [],
  onImage?: ImageClick,
): ToDOM {
  return (view, getPos) => {
    const md = mdOf(view.state);
    let el: HTMLElement;
    if (a.type === "math") {
      // $$…$$ inside a line is a display formula, centred on a line of its own (md-dmath), as in the static render
      el = span(`tiptap-mathematics-render${a.display ? " md-dmath" : ""}`);
      el.dataset.type = "inline-math";
      el.dataset.latex = a.latex;
      renderTex(el, a.latex, a.display, md.math);
    } else if (a.type === "image") {
      let dragged: [number, number] | null = null;
      const img = imageEl(a, false, md);
      el = img;
      el.draggable = true;
      el.addEventListener("dragstart", (ev) => {
        const from = getPos();
        if (from == null || !ev.dataTransfer) return;
        const to = from + raw.length,
          st = view.state;
        dragged = [from, to];
        view.dispatch(st.tr.setSelection(TextSelection.create(st.doc, from, to)).setMeta(DRAG_START, true));
        view.dragging = { slice: view.state.doc.slice(from, to), move: true };
        ev.dataTransfer.effectAllowed = "copyMove";
        ev.dataTransfer.setData("text/plain", raw);
        carryImage(ev.dataTransfer, a);
        ev.dataTransfer.setDragImage(img.querySelector("img") ?? img, 0, 0);
      });
      el.addEventListener("dragend", (ev) => {
        dragEnd(view, ev, dragged);
        dragged = null;
      });
      const frame = img.querySelector<HTMLElement>(".md-imgframe");
      if (frame)
        for (const side of [-1, 1]) {
          const g = span(`md-imgrip ${side < 0 ? "l" : "r"}`);
          g.setAttribute("data-tip", "Drag to resize");
          g.addEventListener("pointerdown", (ev) => resize(ev, g, side, img, frame, view, getPos, a.width));
          frame.parentElement!.append(g);
        }
      imageViews.set(el, getPos);
      // the press may change the selection before the click (the browser's own), so whether it was selected is read here
      let picked = false;
      el.addEventListener("mousedown", () => {
        picked = img.classList.contains("md-picked");
      });
      el.addEventListener("click", (ev) => {
        if (ev.button !== 0 || (ev.target as Element).closest(".md-imgrip")) return;
        ev.preventDefault();
        const from = getPos(),
          cap = (ev.target as Element).closest<HTMLElement>(".md-cap");
        if (from != null) onImage?.(view, from, picked || ev.detail >= 2, cap ? captionHit(cap, ev) : null);
      });
    } else if (a.type === "br") {
      el = span("md-br");
    } else if (a.type === "fn") {
      el = document.createElement("sup");
      el.className = "fnref";
      el.contentEditable = "false";
      el.textContent = a.label;
    } else {
      el = span(`md-atom md-atom-${a.type}`);
      el.innerHTML = staticInline(raw, md);
      // a ref chip drawn as outside the editor: its title, board badge, missing / gone look
      if (a.type === "ref") el.querySelectorAll<HTMLElement>(".md-ref").forEach((r) => md.paintRef(r));
      // one element (a ref chip, an emoji): that element itself, laid out exactly as in the static render
      const only = el.childNodes.length === 1 ? (el.firstElementChild as HTMLElement | null) : null;
      if (only) {
        only.classList.add("md-atom", `md-atom-${a.type}`);
        el = only;
      }
    }
    if (a.type !== "br" && a.type !== "image") {
      el.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        const from = getPos();
        if (from != null) onCaret(view, caret(from));
      });
    }
    let out = el;
    for (let i = wrap.length - 1; i >= 0; i--) {
      const { nodeName, ...attrs } = wrap[i],
        w = document.createElement(nodeName);
      for (const [k, v] of Object.entries(attrs)) w.setAttribute(k, v);
      w.append(out);
      out = w;
    }
    return out;
  };
}

/** Transaction meta: the selection of an image's source that a drag of the image starts with (ProseMirror's drop moves the
 *  selection): not a selected image, the image being dragged stays as it is drawn */
export const DRAG_START = "imageDragStart";

/** The drawn images (not the copies under an open source) and where each one's source starts: the editor marks the selected one */
export const imageViews = new WeakMap<Element, () => number | undefined>();

/** The character of the caption under the pointer: the offset in the caption's rendered text */
function captionHit(cap: HTMLElement, ev: MouseEvent): CaptionHit | null {
  let node: Node | null = null,
    off = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
    if (p) ({ offsetNode: node, offset: off } = p);
  } else {
    const r = document.caretRangeFromPoint?.(ev.clientX, ev.clientY);
    if (r) ({ startContainer: node, startOffset: off } = r);
  }
  if (!node || !cap.contains(node)) return null;
  const r = document.createRange();
  r.setStart(cap, 0);
  r.setEnd(node, off);
  return { text: cap.textContent ?? "", at: r.toString().length };
}

/**
 * The end of an image's drag. Released in this editor, the editor's drop has moved its source already (and cleared
 * view.dragging). Released outside it with a move (the drop target set dropEffect "move": it took the image), the source leaves
 * the document, with the space it stood in and, through the image plugin, a paragraph it leaves empty. Cancelled or refused
 * (dropEffect "none"), nothing changes
 */
function dragEnd(view: EditorView, ev: DragEvent, range: [number, number] | null) {
  const moved = !!view.dragging;
  view.dragging = null;
  if (!moved || !range || ev.dataTransfer?.dropEffect !== "move" || view.isDestroyed) return;
  let [from, to] = range;
  const $f = view.state.doc.resolve(from),
    text = $f.parent.textContent,
    start = $f.start(),
    a = from - start,
    b = to - start;
  if (a > 0 && text[a - 1] === " " && (b === text.length || text[b] === " ")) from--;
  else if (a === 0 && text[b] === " ") to++;
  view.dispatch(view.state.tr.delete(from, to).setMeta(DRAGGED_OUT, true).scrollIntoView());
}

/** Which image is dragged, for a drop outside the editor (IMAGE_DRAG_TYPE) */
function carryImage(dt: DataTransfer, a: Extract<Atom, { type: "image" }>) {
  if (a.broken || !a.src) return;
  const d: DraggedImage = { src: a.src, alt: a.alt, caption: captionOf(a.title) };
  dt.setData(IMAGE_DRAG_TYPE, JSON.stringify(d));
}

/** Narrowest an image can be dragged to, in px; closer than SNAP px to its natural size or the full width, it takes that size */
const MIN_W = 48,
  SNAP = 8;

/** An image as drawn: `below` is the copy under the source while the source is open. The picture sits in a frame (the
 *  selection ring, and what a resize scales), the frame in a box that also holds the resize grips, the caption after the box */
function imageEl(a: Extract<Atom, { type: "image" }>, below: boolean, md: Md): HTMLElement {
  const el = span(`md-img${below ? " below" : ""}`),
    images = md.images;
  // an address the parser could not read: nothing to load, drawn as a failed image
  if (a.broken) {
    el.append(missingImage(a.alt, a.src));
    return el;
  }
  const img = document.createElement("img");
  const at = images.attrs(a);
  for (const [k, v] of Object.entries(at)) if (v != null && k !== "style" && k !== "class") img.setAttribute(k, v);
  // the width of a sized image is on this box (below); an unsized one keeps its height cap
  if (!a.width && at.style) img.setAttribute("style", at.style);
  img.draggable = false;
  // the source shown, as in the static render (picture.ts): the document keeps the address as written
  images.watch(img);
  if (!below && img.src) images.sawLoad(img.getAttribute("src")!);
  const box = span("md-imgbox"),
    frame = span("md-imgframe");
  frame.append(img);
  box.append(frame);
  el.append(box);
  if (images.failedBefore(img.getAttribute("src"))) images.fail(img);
  else
    img.addEventListener("error", () => {
      if (img.getAttribute("src")) images.fail(img);
    });
  const cap = captionOf(a.title);
  if (cap) {
    const c = span("md-cap");
    c.innerHTML = captionHtml(cap, md);
    el.append(c);
  }
  if (a.width) {
    el.style.width = `${a.width}%`;
    el.style.setProperty("--f", String(a.width / 100));
    el.classList.add("sized");
  }
  return el;
}

/** The image under its open source: it can be dragged, which moves its source */
export function imageBelow(a: Extract<Atom, { type: "image" }>): ToDOM {
  return (view, getPos) => {
    const md = mdOf(view.state),
      images = md.images;
    const el = imageEl(a, true, md),
      img = el.querySelector("img");
    // a press keeps the caret in the source; on the image itself it may start a drag (below), which needs the press's default
    el.addEventListener("mousedown", (ev) => {
      if (ev.target !== img) ev.preventDefault();
    });
    const frame = el.querySelector<HTMLElement>(".md-imgframe");
    // an address that failed before is its placeholder already
    if (!img || !frame) return el;
    const src = img.getAttribute("src");
    // addresses already shown under a source load at once (editing the alt text or width rebuilds the widget)
    if (src && !images.loadedBefore(src)) {
      img.removeAttribute("src");
      setTimeout(() => {
        if (el.isConnected) {
          images.sawLoad(src);
          img.setAttribute("src", src);
        }
      }, IMAGE_SETTLE);
    }
    let dragged: [number, number] | null = null;
    frame.draggable = true;
    frame.addEventListener("dragstart", (ev) => {
      const at = imageSource(view, getPos(), "end");
      if (!at || !ev.dataTransfer) return;
      dragged = at;
      const st = view.state,
        raw = st.doc.textBetween(at[0], at[1]);
      view.dispatch(st.tr.setSelection(TextSelection.create(st.doc, at[0], at[1])).setMeta(DRAG_START, true));
      view.dragging = { slice: view.state.doc.slice(at[0], at[1]), move: true };
      ev.dataTransfer.effectAllowed = "copyMove";
      ev.dataTransfer.setData("text/plain", raw);
      carryImage(ev.dataTransfer, a);
      ev.dataTransfer.setDragImage(img, 0, 0);
    });
    frame.addEventListener("dragend", (ev) => {
      dragEnd(view, ev, dragged);
      dragged = null;
    });
    return el;
  };
}

/**
 * Dragging a grip of the selected image: only the frame scales (a transform, nothing below moves or lays out again), the grips
 * following it; on release the width is written once ({width=N%}, of the body's width) and what follows slides to its new place.
 * The natural size (no width written) and the full width catch the drag
 */
function resize(
  e: PointerEvent,
  g: HTMLElement,
  side: number,
  el: HTMLElement,
  frame: HTMLElement,
  view: EditorView,
  getPos: () => number | undefined,
  w0pct: number | null,
) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const box = blockOf(el),
    cs = getComputedStyle(box),
    r = box.getBoundingClientRect();
  const k = box.offsetWidth ? r.width / box.offsetWidth : 1;
  const full = (box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * k,
    f = frame.getBoundingClientRect(),
    img = frame.querySelector("img");
  if (!(full > 0) || !(f.width > 0) || !img) return;
  const w0 = f.width,
    h0 = f.height,
    x0 = e.clientX,
    natural = (Number(img.getAttribute("width")) || img.naturalWidth) * k,
    nat = natural > 0 ? Math.min(full, natural) : w0,
    min = Math.min(w0, MIN_W * k);
  let tw = w0,
    raf = 0,
    moved = false;
  g.setPointerCapture(e.pointerId);
  el.classList.add("resizing");
  const ghosts = mdOf(view.state).ghosts;
  ghosts.hold(true);
  const show = () => {
    const s = tw / w0;
    frame.style.transform = s === 1 ? "" : `scale(${s})`;
    el.style.setProperty("--gx", `${((s - 1) * w0) / 2 / k}px`);
    el.style.setProperty("--gy", `${((s - 1) * h0) / 2 / k}px`);
  };
  const move = (ev: PointerEvent) => {
    moved ||= ev.clientX !== x0;
    if (!moved) return;
    tw = Math.min(full, Math.max(min, w0 + 2 * side * (ev.clientX - x0)));
    for (const t of [nat, full]) if (Math.abs(tw - t) < SNAP) tw = t;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        show();
      });
  };
  const up = () => {
    for (const t of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"])
      g.removeEventListener(t, t === "pointermove" ? (move as EventListener) : up);
    cancelAnimationFrame(raf);
    ghosts.hold(false);
    const w = Math.abs(tw - nat) < 0.5 ? null : Math.min(100, Math.round((tw / full) * 100)),
      from = getPos();
    if (!moved || w === w0pct || from == null) {
      tw = w0;
      show();
      el.classList.remove("resizing");
      return;
    }
    const before = measureImages(view, [view.state.doc.resolve(from).before()]);
    setWidth(view, from, w);
    slideImages(view, before);
  };
  g.addEventListener("pointermove", move);
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) g.addEventListener(t, up);
}
function blockOf(el: HTMLElement): HTMLElement {
  let p = el.parentElement!;
  while (p.parentElement && getComputedStyle(p).display.startsWith("inline")) p = p.parentElement;
  return p;
}

/** The image whose source starts or ends (edge) at pos: its span and where its paragraph's text starts */
function imageAt(view: EditorView, pos: number | undefined, edge: "start" | "end"): { sp: Span; base: number } | null {
  if (pos == null) return null;
  const $e = view.state.doc.resolve(pos),
    p = $e.parent;
  if (!p.isTextblock) return null;
  const base = $e.start(),
    off = pos - base;
  const hit = (s: Span) => s.atom?.type === "image" && (edge === "start" ? s.from : s.to) === off;
  const sp = flat(blockInfo(p.textContent).spans).find(hit);
  return sp?.atom?.type === "image" ? { sp, base } : null;
}
const imageSource = (view: EditorView, pos: number | undefined, edge: "start" | "end"): [number, number] | null => {
  const r = imageAt(view, pos, edge);
  return r ? [r.base + r.sp.from, r.base + r.sp.to] : null;
};

/** Rewrites the width in the attribute block of the image whose source starts at `from` (its other attributes stay) */
function setWidth(view: EditorView, from: number, w: number | null) {
  const r = imageAt(view, from, "start");
  if (!r) return;
  const { sp, base } = r;
  if (sp.atom?.type !== "image") return;
  const at = sp.atom.widthAt,
    text = imageAttrsText({ ...sp.atom, width: w });
  const tr = closeHistory(view.state.tr);
  if (at) {
    if (text) tr.insertText(text, base + at[0], base + at[1]);
    else tr.delete(base + at[0], base + at[1]);
  } else if (text) tr.insertText(text, base + sp.to);
  else return;
  // insertText collapses a selection: the image stays selected
  view.dispatch(tr.setSelection(view.state.selection.map(tr.doc, tr.mapping)));
  view.dispatch(closeHistory(view.state.tr));
}

const FOLD_HEAD = 22,
  FOLD_TAIL = 10;
/** A long image address folds to its head and tail (the middle stays in the document, hidden) */
export const foldRange = (url: [number, number]): [number, number] | null =>
  url[1] - url[0] > FOLD_HEAD + FOLD_TAIL + 6 ? [url[0] + FOLD_HEAD, url[1] - FOLD_TAIL] : null;
export const ellipsis = () => {
  const e = span("md-ell");
  e.textContent = "…";
  return e;
};
const CHEV = (down: boolean) =>
  `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${down ? "M3 4.5l3 3 3-3" : "M3 7.5l3-3 3 3"}"/></svg>`;
/** A link's folded address beside its text: its site; a click on it opens the link's box (session.ts) */
export const urlChip =
  (short: string): ToDOM =>
  () => {
    const e = span("md-urlchip");
    e.textContent = short;
    e.setAttribute("data-tip", "Edit Link");
    return e;
  };
/** A long address written as it is, away from the caret: its site, drawn as the link it is */
export const bareLink =
  (url: string, short: string): ToDOM =>
  () => {
    const e = document.createElement("a");
    e.className = "md-link md-bare";
    e.contentEditable = "false";
    e.setAttribute("href", url);
    e.textContent = short;
    return e;
  };
/** Expand / collapse a folded address */
export function foldButton(expanded: boolean, toggle: (view: EditorView) => void): ToDOM {
  return (view) => {
    const b = span("md-fold");
    b.setAttribute("data-tip", expanded ? "Collapse address" : "Show full address");
    b.innerHTML = `${expanded ? "Collapse" : "Expand"}${CHEV(!expanded)}`;
    b.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggle(view);
    });
    return b;
  };
}

/** The drawn display formula under its source while the caret is in it (like an image's), framed */
export function mathBelow(latex: string): ToDOM {
  return (view) => {
    const math = mdOf(view.state).math;
    const el = span("md-dmath below");
    // as the formula block does: a formula that does not typeset says what is wrong under its red source
    const r = checkMath(latex, true, math);
    if (r.html) el.innerHTML = r.html;
    else {
      renderTex(el, latex, true, math);
      if (r.problem) el.append(problemBox(r.problem, latex, false));
    }
    el.addEventListener("mousedown", (e) => e.preventDefault());
    return el;
  };
}
