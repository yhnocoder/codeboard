// What the editor draws for inline source it hides: formulas, images, line breaks and the rest. Each builder returns a
// widget toDOM function; the source text stays in the document and these elements are never part of it.
import katex from "katex";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { mathTex } from "../schema";
import { mathMacros } from "../math";
import { captionOf, imageAttrs } from "../image";
import { renderMd } from "../render";
import { holdGhosts } from "../ui/ghost";
import { IMAGE_SETTLE } from "../ui/timing";
import { blockInfo, flat, type Atom, type Span } from "./spans";

type Tag = NonNullable<Span["tag"]>;

type ToDOM = (view: EditorView, getPos: () => number | undefined) => HTMLElement;

/** Puts the caret at pos and shows the source there right away (a click on a drawn thing means "edit this") */
export function placeCaret(view: EditorView, pos: number, meta: (tr: import("@tiptap/pm/state").Transaction) => void) {
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos));
  meta(tr);
  view.dispatch(tr);
  view.focus();
}

const span = (cls: string) => { const e = document.createElement("span"); e.className = cls; e.contentEditable = "false"; return e; };

export function renderTex(el: HTMLElement, latex: string, display: boolean) {
  try { katex.render(mathTex(latex, display), el, { throwOnError: false, macros: mathMacros() }); }
  catch { el.textContent = latex; }
}

/** The static render of a piece of inline Markdown (emoji, [[ref]], {text|note}, inline HTML): same DOM as outside the editor */
function staticInline(raw: string): string {
  const h = renderMd(raw).trim();
  return h.startsWith("<p>") && h.endsWith("</p>") ? h.slice(3, -4) : h;
}

/**
 * The drawn form of a hidden atom, at the start of its source. A press puts the caret into the source (caret(from)),
 * which then shows; the image can also be dragged, which moves its source.
 */
/** wrap: the formatting the atom sits in, outermost first (a widget is not inside the inline decorations around it) */
export function atomWidget(a: Atom, raw: string, caret: (from: number) => number, onCaret: (view: EditorView, pos: number) => void, wrap: Tag[] = []): ToDOM {
  return (view, getPos) => {
    let el: HTMLElement;
    if (a.type === "math") {
      el = span("tiptap-mathematics-render");
      el.dataset.type = "inline-math";
      el.dataset.latex = a.latex;
      renderTex(el, a.latex, a.display);
    } else if (a.type === "image") {
      el = imageEl(a, false);
      el.draggable = true;
      el.addEventListener("dragstart", (ev) => {
        const from = getPos();
        if (from == null || !ev.dataTransfer) return;
        const to = from + raw.length, st = view.state;
        view.dispatch(st.tr.setSelection(TextSelection.create(st.doc, from, to)));
        view.dragging = { slice: view.state.doc.slice(from, to), move: true };
        ev.dataTransfer.effectAllowed = "copyMove";
        ev.dataTransfer.setData("text/plain", raw);
        ev.dataTransfer.setDragImage(el.querySelector("img") ?? el, 0, 0);
      });
      el.addEventListener("dragend", () => { view.dragging = null; });
    } else if (a.type === "br") {
      el = span("md-br");
    } else if (a.type === "fn") {
      el = document.createElement("sup");
      el.className = "fnref";
      el.contentEditable = "false";
      el.textContent = a.label;
    } else {
      el = span(`md-atom md-atom-${a.type}`);
      el.innerHTML = staticInline(raw);
      // one element (a ref chip, an emoji): that element itself, laid out exactly as in the static render
      const only = el.childNodes.length === 1 ? el.firstElementChild as HTMLElement | null : null;
      if (only) { only.classList.add("md-atom", `md-atom-${a.type}`); el = only; }
    }
    // The image waits for the click (a press may start a drag); the rest answer the press
    if (a.type !== "br") {
      el.addEventListener(a.type === "image" ? "click" : "mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        const from = getPos();
        if (from != null) onCaret(view, caret(from));
      });
    }
    let out = el;
    for (let i = wrap.length - 1; i >= 0; i--) {
      const { nodeName, ...attrs } = wrap[i], w = document.createElement(nodeName);
      for (const [k, v] of Object.entries(attrs)) w.setAttribute(k, v);
      w.append(out);
      out = w;
    }
    return out;
  };
}

const MIN_W = 24; // narrowest an image can be dragged to, in px

/** An image as drawn: `below` is the copy under the source while the caret is in it, the one with the resize grips */
function imageEl(a: Extract<Atom, { type: "image" }>, below: boolean): HTMLElement {
  const el = span(`md-img${below ? " below" : ""}`), img = document.createElement("img");
  for (const [k, v] of Object.entries(imageAttrs(a))) if (v != null && k !== "style" && k !== "class") img.setAttribute(k, v);
  img.draggable = false;
  if (!below && img.src) loaded.add(img.getAttribute("src")!);
  el.append(img);
  const cap = captionOf(a.title);
  if (cap) { const c = span("md-cap"); c.textContent = cap; el.append(c); }
  if (a.width) { el.style.width = `${a.width}%`; el.classList.add("sized"); }
  return el;
}

/** Addresses already shown under a source: those load at once (editing the alt text or width rebuilds the widget) */
const loaded = new Set<string>();

/** The image under its source; dragging a grip rewrites the {width=N%} after it in one undo step */
export function imageBelow(a: Extract<Atom, { type: "image" }>): ToDOM {
  return (view, getPos) => {
    const el = imageEl(a, true), img = el.querySelector("img")!, src = img.getAttribute("src");
    if (src && !loaded.has(src)) {
      img.removeAttribute("src");
      setTimeout(() => { if (el.isConnected) { loaded.add(src); img.setAttribute("src", src); } }, IMAGE_SETTLE);
    }
    el.addEventListener("mousedown", (ev) => ev.preventDefault());
    for (const side of [-1, 1]) {
      const g = span(`md-imgrip ${side < 0 ? "l" : "r"}`);
      g.setAttribute("data-tip", "Drag to resize · Double-click for full width");
      g.addEventListener("pointerdown", (ev) => grip(ev, g, side, el, view, getPos, a.width));
      g.addEventListener("dblclick", (ev) => { ev.preventDefault(); ev.stopPropagation(); setWidth(view, getPos(), null); });
      el.append(g);
    }
    return el;
  };
}

function grip(e: PointerEvent, g: HTMLElement, side: number, el: HTMLElement, view: EditorView, getPos: () => number | undefined, w0pct: number | null) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const box = blockOf(el), cs = getComputedStyle(box), r = box.getBoundingClientRect();
  const k = box.offsetWidth ? r.width / box.offsetWidth : 1;
  const full = (box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * k;
  if (!(full > 0)) return;
  const w0 = el.getBoundingClientRect().width, x0 = e.clientX, min = Math.min(100, (MIN_W * k / full) * 100);
  let w: number | null = w0pct, frame = 0, moved = false;
  g.setPointerCapture(e.pointerId);
  el.classList.add("resizing");
  holdGhosts(true);
  const show = () => { el.style.width = w ? `${w}%` : ""; el.classList.toggle("sized", !!w); };
  const move = (ev: PointerEvent) => {
    moved ||= ev.clientX !== x0;
    if (!moved) return;
    const p = Math.min(100, Math.max(min, ((w0 + 2 * side * (ev.clientX - x0)) / full) * 100));
    w = p >= 99.5 ? null : Math.round(p);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; show(); });
  };
  const up = () => {
    for (const t of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) g.removeEventListener(t, t === "pointermove" ? move as EventListener : up);
    cancelAnimationFrame(frame);
    el.classList.remove("resizing");
    holdGhosts(false);
    if (moved && w !== w0pct) setWidth(view, getPos(), w);
    else { w = w0pct; show(); }
  };
  g.addEventListener("pointermove", move);
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) g.addEventListener(t, up);
}
function blockOf(el: HTMLElement): HTMLElement {
  let p = el.parentElement!;
  while (p.parentElement && getComputedStyle(p).display.startsWith("inline")) p = p.parentElement;
  return p;
}

/** Rewrites the width suffix of the image whose source ends at `end` (the below widget sits there) */
function setWidth(view: EditorView, end: number | undefined, w: number | null) {
  if (end == null) return;
  const $e = view.state.doc.resolve(end), p = $e.parent;
  if (!p.isTextblock) return;
  const base = $e.start(), off = end - base;
  const sp = flat(blockInfo(p.textContent, true).spans).find((s) => s.atom?.type === "image" && s.to === off)
    ?? flat(blockInfo(p.textContent, false).spans).find((s) => s.atom?.type === "image" && s.to === off);
  if (sp?.atom?.type !== "image") return;
  const at = sp.atom.widthAt, text = w ? `{width=${w}%}` : "";
  const tr = closeHistory(view.state.tr);
  if (at) { if (text) tr.insertText(text, base + at[0], base + at[1]); else tr.delete(base + at[0], base + at[1]); }
  else if (text) tr.insertText(text, end);
  else return;
  view.dispatch(tr);
  view.dispatch(closeHistory(view.state.tr));
}

const FOLD_HEAD = 22, FOLD_TAIL = 10;
/** A long image address folds to its head and tail (the middle stays in the document, hidden) */
export const foldRange = (url: [number, number]): [number, number] | null =>
  url[1] - url[0] > FOLD_HEAD + FOLD_TAIL + 6 ? [url[0] + FOLD_HEAD, url[1] - FOLD_TAIL] : null;
export const ellipsis = () => { const e = span("md-ell"); e.textContent = "…"; return e; };
const CHEV = (down: boolean) => `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${down ? "M3 4.5l3 3 3-3" : "M3 7.5l3-3 3 3"}"/></svg>`;
/** Expand / collapse a folded address */
export function foldButton(expanded: boolean, toggle: (view: EditorView) => void): ToDOM {
  return (view) => {
    const b = span("md-fold");
    b.setAttribute("data-tip", expanded ? "Collapse address" : "Show full address");
    b.innerHTML = `${expanded ? "Collapse" : "Expand"}${CHEV(!expanded)}`;
    b.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); toggle(view); });
    return b;
  };
}
