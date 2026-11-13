// Moving whole blocks of a Note with ⌘ (Ctrl) held while it is being edited. Hovering a block outlines it (the blocks the
// selection spans: one outline round them all). ⌘-drag: the blocks stay as a faint placeholder, a copy follows the pointer
// (over a Note, a small thumbnail at the pointer's lower right) and a line shows where they would land; nothing reflows until
// release. ⌘-click picks them up: the Note closes up and they float 24 px outside its right edge until dragged into a Note,
// or put back (Esc, ⌘Z, ⌘-click on them). Nothing is written before they land:
// - into the Note being edited, from that Note: an editor transaction (the editor's own undo step, saved when editing ends)
// - anywhere else: the editor (if any) is closed first (what was typed is saved as its own step), then one command writes both
//   Notes, one undo step for the two
// The copy, line and outline live in a layer of the world, in world coordinates. Rects are measured once (at the press, and a
// Note's slots the first time the pointer is over it); a pointer move only moves transforms
import "./blockmove.css";
import { createEffect, on, onCleanup } from "solid-js";
import * as C from "@codeboard/core/commands";
import type { NoteCard } from "@codeboard/core";
import {
  cutMdBlocks,
  findMdBlocks,
  insertMdBlocks,
  mdBlockStarts,
  moveMdBlocks,
  type MdPart,
} from "@yhnocoder/markdown";
import type { MdBlocks } from "@yhnocoder/markdown/editor";
import { IS_MAC } from "@yhnocoder/markdown/ui";
import { editorOf } from "./load";
import { commandEnv } from "../actions/env";
import { editing, setEditing } from "../state/ui";
import { cardById, placed, placeOf, rectOf } from "../state/store";
import { cam } from "../state/camera";
import { lastPointer, worldAt } from "../state/measure";
import { boardMap, boardRef, boardSignal, boardTimer, rooted } from "../state/root";
import { animScale, reduceMotion } from "../state/motion";
import { DRAG_SLOP, holdGesture, track } from "../gesture";
import { cardSel } from "../cardsel";

/** The copy over a Note: its longer side at most this many screen px */
const THUMB = 132;
/** The copy of text blocks sits on a sheet this much bigger than the text (world px) */
const PX = 12,
  PY = 8;
/** A picked-up block floats this far (world px) right of its Note */
const FLOAT_GAP = 24;
/** a floating copy is at most this share of the window high */
const FLOAT_FIT = 0.6;
/** and is kept this far (screen px) inside the board's top and bottom */
const EDGE = 16;
/** A Note counts as under the pointer this far (screen px) outside its edges */
const NEAR = 12;
const SETTLE_MS = 200,
  FLIP_MS = 160;
const EASE = "cubic-bezier(.2,.7,.3,1)";
/** The editor's own controls drawn inside blocks (a heading's level chip, a table's grips and drag pieces, an image's
 *  resize grips): not part of the copy */
const EDIT_UI =
  "button, .mdui, .md-hchip, .md-tov, .md-tghost, .md-thole, .md-tdrop, .md-tgone, .md-imgrip, .md-rowline, .md-rowshield, .md-tcount, .ProseMirror-gapcursor";

type Kind = "text" | "code" | "table" | "img";
type Rect = { x: number; y: number; w: number; h: number };
/** Where blocks can land in one Note: its world rect, the text column, and each block's top and bottom (world) */
type Slots = { card: string; r: Rect; x: number; w: number; top: number; R: { i: number; top: number; bot: number }[] };
type Target = { card: string; idx: number; x: number; w: number; y: number; noop: boolean };
type Move = {
  src: string;
  /** the blocks in the source: editor blocks while it is being edited, rendered blocks after */
  range: [number, number];
  /** what a floating copy carries, to find its blocks again when its Note's editor closes */
  part: MdPart | null;
  g: HTMLElement;
  sheet: HTMLElement;
  kind: Kind;
  /** natural size (world px) */
  w: number;
  h: number;
  /** the grabbed point in the copy (world px at scale 1) */
  ox: number;
  oy: number;
  /** pointer (world) */
  px: number;
  py: number;
  /** the copy's top left (world) and scale while not over a Note */
  tx: number;
  ty: number;
  float: boolean;
  drag: boolean;
  over: boolean;
  tgt: Target | null;
  settling: boolean;
  slots: Map<string, Slots | null>;
  /** the element holding the pointer while dragging (its cursor is the one shown) */
  held: Element | null;
  /** ends the move's hold as a gesture: a board switch before it ends drops it (dropMove) */
  done: () => void;
};

const mv = boardRef<Move | null>(null);
/** The move as a signal, for what follows its source Note's Markdown while it floats */
const [moving, setMoving] = boardSignal<Move | null>(null);
const swapTimer = boardTimer(),
  glideTimer = boardTimer(),
  settleTimer = boardTimer();
/** what the outline is round now */
const hot = boardRef<{ card: string; a: number; b: number } | null>(null);
/** ⌘ (Ctrl) is held; a press of ours whose click and mousedown are not the editor's */
const keys = boardRef({ mod: false, eatClick: false });
/** The layer in the world (which outlives boards) and the style rule hiding picked-up rendered blocks: emptied by dropMove */
const view: {
  lay: HTMLElement | null;
  box: HTMLElement | null;
  line: HTMLElement | null;
  hideRule: HTMLStyleElement | null;
} = { lay: null, box: null, line: null, hideRule: null };

/** The grabbing cursor, on the element that holds the pointer (a class on the page would restyle the whole board) */
function grabbing(d: Move, on: boolean) {
  d.held?.classList.toggle("bmv-grabbing", on);
  if (!on) d.held = null;
}
/** What is under the pointer beneath the block-move layer */
/** The key that picks up blocks: ⌘ on a Mac (Ctrl-click there is the context menu), Ctrl elsewhere */
const modHeld = (e: MouseEvent | KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);
const under = (e: PointerEvent) =>
  document.elementsFromPoint(e.clientX, e.clientY).find((x) => !view.lay?.contains(x)) ?? null;
const cardEl = (id: string) => document.querySelector<HTMLElement>(cardSel(id));
const bodyOf = (ce: HTMLElement) => ce.querySelector<HTMLElement>(":scope > .cface > .md");
const isNote = (id: string) => {
  const c = cardById(id)?.card;
  return c?.kind === "note" && c.look !== "freetext" && !placeOf(id).locked;
};
const edBlocks = (id: string): MdBlocks | null => editorOf(id)?.blocks() ?? null;

/** The layer in the world the copy, line and outline are drawn in (made again when the world was) */
function layer(): HTMLElement | null {
  if (view.lay?.isConnected) return view.lay;
  const w = document.querySelector<HTMLElement>("#board > .world");
  if (!w) return null;
  const lay = (view.lay = document.createElement("div"));
  lay.className = "bmv-lay";
  // the outline takes the pointer while ⌘ is held, for its grab cursor: a cursor rule on the card's descendants would be
  // matched against every element of a long Note each time the outline shows or hides
  const box = (view.box = document.createElement("div"));
  box.className = "bmv-box";
  box.addEventListener("pointermove", (e) => {
    keys.v.mod = modHeld(e);
    if (hot.v) hover(hot.v.card, under(e));
  });
  box.addEventListener("pointerleave", (e) => {
    const id = hot.v?.card,
      ce = id && cardEl(id);
    if (!(ce && e.relatedTarget instanceof Node && ce.contains(e.relatedTarget))) clearHover();
  });
  box.addEventListener("pointerdown", (e) => {
    if (hot.v) blockDown(hot.v.card, e, under(e));
  });
  view.line = document.createElement("div");
  view.line.className = "bmv-line";
  lay.append(view.box, view.line);
  w.append(lay);
  return lay;
}

/** A Note's blocks as drawn: the editor's while it is being edited, else the rendered ones when they match its Markdown */
function blockEls(id: string): HTMLElement[] | null {
  const ed = edBlocks(id);
  if (ed) return ed.els();
  const ce = cardEl(id),
    body = ce && bodyOf(ce),
    c = cardById(id)?.card;
  if (!body || body.classList.contains("editing") || body.classList.contains("md-pend") || c?.kind !== "note")
    return null;
  const starts = mdBlockStarts(c.md),
    kids = [...body.children] as HTMLElement[];
  return starts && starts.length === kids.length ? kids : null;
}

/** An element's rect in world coordinates (layout read: only at a press, a drop, or a Note entered) */
function worldRect(el: Element): Rect {
  const r = el.getBoundingClientRect(),
    p = worldAt({ x: r.left, y: r.top });
  return { x: p.x, y: p.y, w: r.width / cam.z, h: r.height / cam.z };
}

function measure(id: string): Slots | null {
  const ce = cardEl(id),
    body = ce && bodyOf(ce),
    els = blockEls(id);
  if (!ce || !body) return null;
  const cr = rectOf(id),
    br = worldRect(body),
    cs = getComputedStyle(body);
  const pl = parseFloat(cs.paddingLeft) || 0,
    pr = parseFloat(cs.paddingRight) || 0,
    pt = parseFloat(cs.paddingTop) || 0;
  const R: Slots["R"] = [];
  (els ?? []).forEach((el, i) => {
    const r = worldRect(el);
    if (r.h > 0) R.push({ i, top: r.y, bot: r.y + r.h });
  });
  return {
    card: id,
    r: cr,
    x: br.x + pl,
    w: br.w - pl - pr,
    top: br.y + pt,
    R: els ? R : [],
  };
}

/** The Note under a world point (the topmost) and where the blocks would land in it */
function slotAt(d: Move, x: number, y: number): Target | null {
  const m = NEAR / cam.z;
  const cs = placed();
  for (let k = cs.length - 1; k >= 0; k--) {
    const c = cs[k];
    if (!isNote(c.id)) continue;
    const r = rectOf(c.id);
    if (x < r.x - m || x > r.x + r.w + m || y < r.y - m || y > r.y + r.h + m) continue;
    if (!d.slots.has(c.id)) d.slots.set(c.id, measure(c.id));
    const s = d.slots.get(c.id);
    if (!s) return null;
    const R = s.R;
    let j = 0;
    while (j < R.length && (R[j].top + R[j].bot) / 2 < y) j++;
    const n = blockCount(c.id) ?? R.length;
    const idx = j < R.length ? R[j].i : n;
    const gap = 6;
    const ly = !R.length
      ? s.top + gap
      : j === 0
        ? R[0].top - gap
        : j === R.length
          ? R[j - 1].bot + gap
          : (R[j - 1].bot + R[j].top) / 2;
    const noop = c.id === d.src && idx >= d.range[0] && idx <= d.range[1];
    return { card: c.id, idx, x: s.x, w: s.w, y: ly, noop };
  }
  return null;
}
function blockCount(id: string): number | null {
  const ed = edBlocks(id);
  if (ed) return ed.els().length;
  const c = cardById(id)?.card;
  return c?.kind === "note" ? (mdBlockStarts(c.md)?.length ?? null) : null;
}

function showLine(t: Target | null) {
  const line = view.line;
  if (!line) return;
  if (!t) {
    line.classList.remove("is-on");
    return;
  }
  const jump = !line.classList.contains("is-on") || line.dataset.card !== t.card;
  if (jump) line.classList.add("is-jump");
  line.style.width = `${t.w}px`;
  line.style.height = `${2 / cam.z}px`;
  line.style.transform = `translate(${t.x}px, ${t.y - 1 / cam.z}px)`;
  if (jump) {
    void line.offsetWidth;
    line.classList.remove("is-jump");
  }
  line.dataset.card = t.card;
  line.classList.add("is-on");
}

/** A paragraph's text as read, without the editor's hidden source (an image's `![](…)` is there while it is drawn) */
function shownText(p: HTMLElement): string {
  let t = "";
  const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode())
    if (!n.parentElement?.closest(".md-hide, .md-img")) t += n.nodeValue ?? "";
  return t.trim();
}

function kindOf(els: HTMLElement[]): Kind {
  if (els.length !== 1) return "text";
  const e = els[0];
  if (e.matches("pre, .md-code")) return "code";
  if (e.matches("table, .tableWrapper")) return "table";
  if (e.tagName === "P" && e.querySelectorAll("img").length === 1 && !shownText(e)) return "img";
  return "text";
}

/** The rows a tall copy is cut by: a code block's lines, a table's rows, else the blocks themselves */
const unitsOf = (kind: Kind, root: ParentNode, els: HTMLElement[]): Element[] =>
  kind === "code" ? [...root.querySelectorAll(".cm-line")] : kind === "table" ? [...root.querySelectorAll("tr")] : els;

/**
 * The copy of blocks els of Note id: their clones inside the Note's own classes (so they look as they do there). Blocks taller
 * than a readable window are cut to it (the top part for a float, the part round the grabbed point for a drag) with a fade at
 * the cut edges: only the rows in it are cloned, so a long code block costs no more than a short one to lift and draw
 */
function makeCopy(id: string, els: HTMLElement[], float: boolean, grabY: number) {
  const L = layer()!,
    ce = cardEl(id)!,
    body = bodyOf(ce)!,
    pm = body.querySelector<HTMLElement>(".md-pm");
  const kind = kindOf(els);
  const first = worldRect(els[0]),
    last = els.length > 1 ? worldRect(els[els.length - 1]) : first;
  const tall = last.y + last.h - first.y,
    win = (FLOAT_FIT * window.innerHeight) / cam.z;
  // the window's top (world): the blocks' own top, or round the grabbed point
  const top = tall <= win || float ? first.y : Math.max(first.y, Math.min(grabY - win / 2, first.y + tall - win));
  const cut = tall > win;
  const units = cut ? unitsOf(kind, els[0], els) : [];
  const out = new Set<number>();
  let lift = 0;
  if (cut) {
    const rs = units.map(worldRect);
    rs.forEach((r, i) => {
      if (r.y + r.h <= top || r.y >= top + win) out.add(i);
    });
    // what is cut above the window: the copy starts that much lower
    const k = rs.findIndex((_, i) => !out.has(i));
    if (k > 0) lift = rs[k].y - rs[0].y;
  }
  let x: number, y: number, w: number;
  if (kind === "text") {
    x = first.x - PX;
    y = first.y - PY + lift;
    w = first.w + 2 * PX;
  } else {
    x = first.x;
    y = first.y + lift;
    w = first.w;
  }
  const g = document.createElement("div");
  g.className = `bmv-g k-${kind}`;
  const sh = document.createElement("div");
  sh.className = "bmv-sh";
  // the card's classes for the theme's Note styles; no data-id, so it is no card to the board
  const sheet = document.createElement("div");
  sheet.className = `${ce.className} bmv-copy`;
  sheet.classList.remove("sel", "solo", "editing");
  const face = document.createElement("div");
  face.className = "cface";
  const b = document.createElement("div");
  b.className = body.className;
  b.classList.remove("hidehead", "fold", "editing");
  b.classList.add("md");
  const inner = pm ? document.createElement("div") : b;
  if (pm) {
    inner.className = "md-pm";
    b.append(inner);
  }
  const kept = kind === "text" && cut ? els.filter((_, i) => !out.has(i)) : els;
  for (const [k, el] of kept.entries()) {
    const c = el.cloneNode(true) as HTMLElement;
    if (cut && kind !== "text") unitsOf(kind, c, []).forEach((u, i) => out.has(i) && u.remove());
    c.classList.remove("md-mv-dim", "md-mv-away", "md-mv-gone", "ProseMirror-selectednode");
    for (const e of [c, ...c.querySelectorAll("[contenteditable]")]) e.removeAttribute("contenteditable");
    for (const e of c.querySelectorAll(EDIT_UI)) e.remove();
    for (const e of c.querySelectorAll(".md-picked")) e.classList.remove("md-picked");
    if (!k) c.style.setProperty("margin-top", "0", "important");
    if (k === kept.length - 1) c.style.setProperty("margin-bottom", "0", "important");
    inner.append(c);
  }
  face.append(b);
  sheet.append(face);
  sheet.style.width = `${w}px`;
  if (cut) {
    g.classList.add("is-cut");
    g.classList.toggle("cut-top", top > first.y + 0.5);
    sheet.style.maxHeight = `${win}px`;
  }
  g.append(sh, sheet);
  g.addEventListener("pointerdown", floatDown);
  L.append(g);
  // code and tables scroll sideways: the copy shows the same part
  if (kind === "code" || kind === "table") {
    const from = els[0].querySelector(".cm-scroller, .tableWrapper") ?? els[0],
      to = inner.firstElementChild?.querySelector(".cm-scroller, .tableWrapper") ?? inner.firstElementChild;
    if (to) to.scrollLeft = from.scrollLeft;
  }
  const h = sheet.offsetHeight;
  return { g, sheet, kind, x, y, w, h };
}

/** The copy's scale off any Note: a floating copy the board has since been zoomed in on is shown smaller, so it still fits
 *  beside its Note on screen */
const restK = (d: Move) =>
  (d.float ? Math.min(1, (FLOAT_FIT * window.innerHeight) / (cam.z * d.h)) : 1) * (d.drag ? 1.012 : 1);

/** Draws the copy where the move says: over a Note a thumbnail at the pointer's lower right, else where it was grabbed */
function place(d: Move) {
  const over = d.over && d.drag;
  if (over !== d.g.classList.contains("is-over") && !d.g.classList.contains("is-glide")) {
    d.g.classList.add("is-swap");
    swapTimer.start(() => d.g.classList.remove("is-swap"), 130 * animScale());
  }
  let k: number, x: number, y: number;
  if (over) {
    k = Math.min(1, THUMB / (cam.z * Math.max(d.w, d.h)));
    x = d.px + 14 / cam.z;
    y = d.py + 16 / cam.z;
  } else {
    k = restK(d);
    x = d.tx + d.ox * (1 - k);
    y = d.ty + d.oy * (1 - k);
  }
  d.g.style.translate = `${x}px ${y}px`;
  d.g.style.scale = String(k);
  // only on the two pieces that draw with it (--ik is not inherited, blockmove.css): inherited, a change (each step of the
  // thumbnail's scale) would restyle every node of the copy
  const ik = String(1 / (k * cam.z));
  (d.g.firstElementChild as HTMLElement).style.setProperty("--ik", ik);
  d.sheet.style.setProperty("--ik", ik);
  d.g.classList.toggle("is-over", over);
}

/** Block tops (world) of the Notes, by block index: for sliding the others to their new places */
function topsOf(id: string): number[] {
  return (blockEls(id) ?? []).map((e) => worldRect(e).y);
}
/** Blocks of a Note slide from the tops they were drawn at (by their index before: map gives it from the index now) */
function flip(id: string, old: number[], map: (i: number) => number | null) {
  if (reduceMotion()) return;
  const els = blockEls(id) ?? [];
  // every top read before the first animation starts: one layout, not one per block
  const now = els.map((e) => worldRect(e).y);
  els.forEach((e, i) => {
    const j = map(i);
    if (j === null || old[j] === undefined) return;
    const dy = old[j] - now[i];
    if (Math.abs(dy) >= 0.5)
      e.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: FLIP_MS * animScale(),
        easing: EASE,
      });
  });
}

/** A Note's height change: the bottom edge slides from the old height to the new (a clip; the card's bottom edge and shadow
 *  are drawn by a strip that moves with it). Cards are placed on their own, so nothing else moves */
const clips = boardMap<string, { a: Animation; edge: HTMLElement; ce: HTMLElement }>();
function clipCard(id: string, h0: number) {
  endClip(id);
  const ce = cardEl(id);
  if (!ce || !ce.classList.contains("autoh") || reduceMotion()) return;
  const h1 = ce.offsetHeight;
  if (Math.abs(h1 - h0) < 0.5) return;
  const H = Math.max(h0, h1),
    S = 48;
  if (h0 > h1) ce.style.height = `${H}px`;
  const ins = (b: number) => `inset(-${S}px -${S}px ${b}px -${S}px)`;
  const cs = getComputedStyle(ce),
    R = parseFloat(cs.borderBottomLeftRadius) || 0;
  const edge = document.createElement("div");
  edge.className = "bmv-edge";
  Object.assign(edge.style, {
    left: ce.style.left,
    top: `${ce.offsetTop - 2 * R}px`,
    width: `${ce.offsetWidth}px`,
    height: `${2 * R}px`,
    background: cs.backgroundColor,
    // the card's shadow and edge are drawn by its ::before and ::after
    boxShadow: [cs.boxShadow, getComputedStyle(ce, "::before").boxShadow, getComputedStyle(ce, "::after").boxShadow]
      .filter((x) => x && x !== "none")
      .join(", "),
    borderRadius: `0 0 ${R}px ${R}px`,
    clipPath: `inset(${R}px -${S}px -${S}px -${S}px)`,
    // a tilted card: the strip turns with it, round the card's centre
    rotate: ce.style.rotate,
    transformOrigin: `${ce.offsetWidth / 2}px ${2 * R + ce.offsetHeight / 2}px`,
  });
  // in the block-move layer, not among the cards the board draws
  (layer() ?? ce.parentElement)?.append(edge);
  const o = { duration: FLIP_MS * animScale(), easing: EASE };
  const a = ce.animate([{ clipPath: ins(H - h0) }, { clipPath: ins(H - h1) }], o);
  edge.animate([{ transform: `translateY(${h0}px)` }, { transform: `translateY(${h1}px)` }], {
    ...o,
    fill: "forwards",
  });
  clips.set(id, { a, edge, ce });
  a.onfinish = () => endClip(id);
}
function endClip(id: string) {
  const c = clips.get(id);
  if (!c) return;
  clips.delete(id);
  c.a.onfinish = null;
  c.a.cancel();
  c.edge.remove();
  c.ce.style.height = "";
}

/** Rendered blocks of a Note that is not being edited hidden while they float (a style rule: it holds across re-renders) */
function hideStatic(id: string | null, r?: [number, number]) {
  if (!id || !r) {
    view.hideRule?.remove();
    view.hideRule = null;
    return;
  }
  view.hideRule ??= document.head.appendChild(document.createElement("style"));
  view.hideRule.textContent = `${cardSel(id)} > .cface > .md:not(.editing) > :nth-child(n + ${r[0] + 1}):nth-child(-n + ${r[1]}) { display: none !important; }`;
}

/** Marks the moved blocks in a Note: in its editor, or on its rendered blocks */
function markBlocks(id: string, r: [number, number] | null, how: "dim" | "away" | "gone") {
  const ed = edBlocks(id);
  if (ed) return ed.mark(r, how);
  if (how === "away") return hideStatic(r ? id : null, r ?? undefined);
  (blockEls(id) ?? []).forEach((e, i) => {
    e.style.visibility = r && i >= r[0] && i < r[1] && how === "gone" ? "hidden" : "";
  });
}

function clearHover() {
  hot.v = null;
  view.box?.classList.remove("is-on");
}
/** ⌘ held over a block of the Note being edited: one outline round the blocks a press would take */
function hover(id: string, t: EventTarget | null) {
  const ed = edBlocks(id);
  if (!keys.v.mod || !ed || mv.v || !(t instanceof Element) || t.closest("a[href]")) return clearHover();
  const els = ed.els(),
    i = els.findIndex((e) => e.contains(t));
  if (i < 0) return clearHover();
  const [a, b] = ed.group(i);
  if (hot.v?.card === id && hot.v.a === a && hot.v.b === b) return;
  hot.v = { card: id, a, b };
  const box = layer() && view.box;
  if (!box) return;
  const r0 = worldRect(els[a]),
    rs = els.slice(a, b).map(worldRect);
  const l = Math.min(...rs.map((r) => r.x)),
    r = Math.max(...rs.map((q) => q.x + q.w)),
    bot = Math.max(...rs.map((q) => q.y + q.h));
  Object.assign(box.style, {
    transform: `translate(${l}px, ${r0.y}px)`,
    width: `${r - l}px`,
    height: `${bot - r0.y}px`,
  });
  // a custom property is only set through setProperty (as a key of style it is ignored)
  box.style.setProperty("--ik", String(1 / cam.z));
  box.classList.add("is-on");
}

function startMove(id: string, range: [number, number], float: boolean, p: { x: number; y: number }): Move | null {
  const ed = edBlocks(id);
  if (!ed || !layer()) return null;
  const els = ed.els().slice(range[0], range[1]);
  if (!els.length) return null;
  const c = makeCopy(id, els, float, p.y);
  const d: Move = {
    src: id,
    range,
    part: float ? ed.part(range[0], range[1]) : null,
    g: c.g,
    sheet: c.sheet,
    kind: c.kind,
    w: c.w,
    h: c.h,
    ox: p.x - c.x,
    oy: p.y - c.y,
    px: p.x,
    py: p.y,
    tx: c.x,
    ty: c.y,
    float,
    drag: false,
    over: false,
    tgt: null,
    settling: false,
    slots: new Map(),
    held: null,
    // the move outlives the press that started it (a picked-up block floats): held until it lands or is put back
    done: holdGesture(dropMove),
  };
  mv.v = d;
  setMoving(d);
  clearHover();
  place(d);
  return d;
}

/** ⌘-drag: the blocks stay as a faint placeholder; the copy follows the pointer */
function liftDrag(id: string, range: [number, number], p: { x: number; y: number }, held: Element) {
  const d = startMove(id, range, false, p);
  if (!d) return;
  markBlocks(id, range, "dim");
  void d.g.offsetWidth;
  d.drag = true;
  d.g.classList.add("is-lift");
  place(d);
  d.held = held;
  grabbing(d, true);
}

/** ⌘-click: the blocks are taken out (the Note closes up) and float right of it */
function pickUp(id: string, range: [number, number], p: { x: number; y: number }) {
  const ce = cardEl(id);
  const h0 = ce?.offsetHeight ?? 0,
    old = topsOf(id);
  const d = startMove(id, range, true, p);
  if (!d) return;
  markBlocks(id, range, "away");
  clipCard(id, h0);
  flip(id, old, (i) => (i >= range[0] && i < range[1] ? null : i));
  const r = rectOf(id);
  d.tx = r.x + r.w + FLOAT_GAP;
  d.ox = d.oy = 0;
  // level with its blocks, but on screen when they began above or end below it
  const vr = document.querySelector("#board")?.getBoundingClientRect();
  if (vr) {
    const top = worldAt({ x: 0, y: vr.top + EDGE }).y,
      bot = worldAt({ x: 0, y: vr.bottom - EDGE }).y;
    d.ty = Math.max(top, Math.min(d.ty, bot - restK(d) * d.h));
  }
  void d.g.offsetWidth;
  d.g.classList.add("is-glide", "is-lift", "is-float");
  place(d);
  glideTimer.start(() => d.g.classList.remove("is-glide"), (SETTLE_MS + 20) * animScale());
}

function dragTo(d: Move, x: number, y: number) {
  d.px = x;
  d.py = y;
  d.tgt = slotAt(d, x, y);
  d.over = !!d.tgt;
  d.tx = x - d.ox;
  d.ty = y - d.oy;
  place(d);
  // ⌘-dragged back onto itself: the placeholder is where it lands, no line; a floating block put back shows one
  showLine(d.tgt && !(d.tgt.noop && !d.float) ? d.tgt : null);
}

/** The floating copy grabbed (no ⌘): the scale's origin moves to the pressed point, so nothing jumps */
function floatGrab(d: Move, p: { x: number; y: number }, held: Element) {
  const k = restK(d);
  const vx = d.tx + d.ox * (1 - k),
    vy = d.ty + d.oy * (1 - k);
  d.ox = (p.x - vx) / k;
  d.oy = (p.y - vy) / k;
  d.tx = p.x - d.ox;
  d.ty = p.y - d.oy;
  d.g.classList.remove("is-glide");
  d.slots.clear();
  d.drag = true;
  place(d);
  d.held = held;
  grabbing(d, true);
}

function release(d: Move) {
  grabbing(d, false);
  if (mv.v !== d || d.settling) return;
  const t = d.tgt;
  if (t && !t.noop) return settle(d, t);
  if (t || !d.float) return settle(d, null);
  // a floating block let go off any Note stays there
  d.drag = false;
  d.over = false;
  showLine(null);
  place(d);
}

const noteOf = (id: string): MdPart | null => {
  const c = cardById(id)?.card;
  return c?.kind === "note" ? { md: c.md, layout: (c as NoteCard).mdLayout ?? null } : null;
};

/**
 * Writes the move. Returns where the first moved block is in the destination afterwards, or null when nothing could be
 * written (the copy then goes back)
 */
function commit(d: Move, t: Target): number | null {
  const n = d.range[1] - d.range[0];
  const sEd = edBlocks(d.src),
    dEd = edBlocks(t.card);
  const r = [...(sEd?.marked() ?? d.range)] as [number, number];
  if (t.card === d.src && sEd) return sEd.move(r[0], r[1], t.idx) ? (t.idx > r[1] ? t.idx - n : t.idx) : null;
  const src = noteOf(d.src),
    dst = noteOf(t.card);
  if (!src || !dst) return null;
  // a floating block's Note may have changed since it was picked up (an undo, a sync): its blocks are found again, or it
  // goes back
  if (!sEd && d.part) {
    const at = findMdBlocks(src.md, d.part.md, r[0]);
    if (!at) return null;
    r[0] = at[0];
    r[1] = at[1];
  }
  let notes: { id: string; md: string; layout: MdPart["layout"] }[];
  if (t.card === d.src) {
    const m = moveMdBlocks(src, r[0], r[1], t.idx);
    if (!m) return null;
    notes = [{ id: d.src, ...m }];
  } else {
    // an open editor with nothing typed in it is its saved text: that is cut, so the blocks not moved stay as written
    const cut = sEd && !sEd.holds(src) ? sEd.cut(r[0], r[1]) : cutMdBlocks(src, r[0], r[1]);
    const into =
      cut && (dEd && !dEd.holds(dst) ? dEd.withInserted(t.idx, cut.part) : insertMdBlocks(dst, t.idx, cut.part));
    if (!cut || !into) return null;
    notes = [
      { id: d.src, ...cut.rest },
      { id: t.card, ...into },
    ];
  }
  // the editor's own text first, as when it is left (its own undo step); then the move, one step for both Notes
  if (editing()) setEditing(null);
  hideStatic(null);
  C.moveNoteBlocks(commandEnv, notes);
  return t.card === d.src && t.idx > r[1] ? t.idx - n : t.idx;
}

/**
 * Lands the copy: t = where (null: back where it came from). Only now the Notes change: the other blocks slide to their new
 * places, the Notes' bottom edges slide, and the copy, laid out again at the destination's width, glides into its place
 */
function settle(d: Move, t: Target | null) {
  d.settling = true;
  const cs = getComputedStyle(d.g),
    tr = cs.translate === "none" ? [0, 0] : cs.translate.split(" ").map(parseFloat),
    kv = cs.scale === "none" ? 1 : parseFloat(cs.scale);
  d.drag = false;
  d.over = false;
  showLine(null);
  grabbing(d, false);
  const ids = [...new Set([d.src, t?.card ?? d.src])];
  for (const id of ids) endClip(id);
  const before = new Map(ids.map((id) => [id, { h: cardEl(id)?.offsetHeight ?? 0, tops: topsOf(id) }]));
  const n = d.range[1] - d.range[0],
    r0 = edBlocks(d.src)?.marked() ?? d.range;
  let dst = d.src,
    at: number | null = null;
  if (t) {
    at = commit(d, t);
    if (at !== null) dst = t.card;
  }
  if (at === null) {
    at = r0[0];
    markBlocks(d.src, null, "away");
    hideStatic(null);
  }
  markBlocks(dst, [at, at + n], "gone");
  for (const id of ids) {
    const b = before.get(id)!;
    clipCard(id, b.h);
    const moved = (i: number) => i >= at! && i < at! + n;
    // each block's index before the change, from its index now
    const old = (j: number) => (j < r0[0] ? j : j + n);
    flip(id, b.tops, (i) => {
      if (id === dst && moved(i)) return null;
      if (dst === d.src) return t ? old(i < at! ? i : i - n) : i;
      if (id === d.src) return old(i);
      return i < at! ? i : i - n;
    });
  }
  const el = blockEls(dst)?.[at];
  const goal = el ? worldRect(el) : { x: d.tx, y: d.ty, w: d.w, h: d.h };
  const w = d.kind === "text" ? goal.w + 2 * PX : goal.w;
  const k0 = (kv * d.w) / w;
  d.w = w;
  d.g.classList.remove("is-over", "is-swap", "is-glide", "is-float");
  d.g.style.transition = "none";
  d.sheet.style.width = `${w}px`;
  d.g.style.translate = `${tr[0]}px ${tr[1] ?? 0}px`;
  d.g.style.scale = String(k0);
  void d.g.offsetWidth;
  d.g.style.transition = "";
  d.g.classList.add("is-glide");
  d.g.classList.remove("is-lift");
  d.g.style.translate = `${d.kind === "text" ? goal.x - PX : goal.x}px ${d.kind === "text" ? goal.y - PY : goal.y}px`;
  d.g.style.scale = "1";
  settleTimer.start(
    () => {
      d.g.remove();
      end(d);
      markBlocks(dst, null, "gone");
    },
    reduceMotion() ? 0 : (SETTLE_MS + 10) * animScale(),
  );
}

function end(d: Move) {
  d.done();
  if (mv.v === d) {
    mv.v = null;
    setMoving(null);
  }
}
/** Put back at once, no animation (a board switch, the source opened again) */
function dropMove() {
  const d = mv.v;
  showLine(null);
  hideStatic(null);
  if (!d) return;
  end(d);
  grabbing(d, false);
  d.g.remove();
  if (!d.settling) markBlocks(d.src, null, "dim");
  for (const id of [...clips.keys()]) endClip(id);
}
const back = () => {
  const d = mv.v;
  if (d && !d.settling) settle(d, null);
};

/** A press with ⌘ on a block of the Note being edited: a drag moves it, a click picks it up */
function blockDown(id: string, e: PointerEvent, t = e.target as Element | null) {
  if (e.button !== 0 || !modHeld(e) || mv.v || !t) return clearHover();
  if (t.closest("a[href]")) return;
  const ed = edBlocks(id);
  const i = ed ? ed.els().findIndex((x) => x.contains(t)) : -1;
  if (!ed || i < 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  keys.v.eatClick = true;
  const range = ed.group(i);
  const p0 = worldAt({ x: e.clientX, y: e.clientY });
  // the element the pointer is held by shows the grabbing cursor
  const held = e.target as Element;
  track(
    e,
    (ev) => {
      const p = worldAt({ x: ev.clientX, y: ev.clientY });
      if (!mv.v) liftDrag(id, range, p0, held);
      const d = mv.v;
      if (d?.drag) dragTo(d, p.x, p.y);
    },
    (ev, moved) => {
      if (!moved) return pickUp(id, range, p0);
      const d = mv.v;
      if (!d) return;
      const p = worldAt({ x: ev.clientX, y: ev.clientY });
      dragTo(d, p.x, p.y);
      release(d);
    },
    DRAG_SLOP,
    dropMove,
  );
}

/** A press on the floating copy: with ⌘ it goes back, else it is dragged (no ⌘ needed) */
function floatDown(e: PointerEvent) {
  const d = mv.v;
  if (!d || d.settling || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  keys.v.eatClick = true;
  if (modHeld(e)) return back();
  const p0 = worldAt({ x: e.clientX, y: e.clientY });
  track(
    e,
    (ev) => {
      if (mv.v !== d || d.settling) return;
      if (!d.drag) floatGrab(d, p0, e.target as Element);
      const p = worldAt({ x: ev.clientX, y: ev.clientY });
      dragTo(d, p.x, p.y);
    },
    (_ev, moved) => {
      if (moved) release(d);
    },
    DRAG_SLOP,
    dropMove,
  );
}

/** Wires ⌘-moving blocks: the editing Note's element takes ⌘-presses before its editor, the keys put a floating block back */
export function wireBlockMove() {
  // a floating copy is scaled for the zoom (restK): drawn again as the board is zoomed, not only when next grabbed
  rooted(() =>
    createEffect(
      on(
        () => (moving() ? cam.z : null),
        () => {
          const d = mv.v;
          if (d?.float && !d.drag && !d.settling) place(d);
        },
        { defer: true },
      ),
    ),
  );
  // a floating block whose Note is not being edited: its blocks are found again when the Note's Markdown changes (an undo,
  // a sync, another window), and hidden there; gone, the copy goes
  rooted(() =>
    createEffect(
      on(
        () => {
          const d = moving(),
            c = d?.part ? cardById(d.src)?.card : undefined;
          return c?.kind === "note" ? c.md : null;
        },
        (md) => {
          const d = mv.v;
          if (md === null || !d?.part || d.settling || edBlocks(d.src)) return;
          const r = findMdBlocks(md, d.part.md, d.range[0]);
          if (!r) return dropMove();
          d.range = r;
          d.slots.clear();
          hideStatic(d.src, r);
        },
        { defer: true },
      ),
    ),
  );
  const modKey = (e: KeyboardEvent) => e.key === (IS_MAC ? "Meta" : "Control");
  window.addEventListener(
    "keydown",
    (e) => {
      if (modKey(e)) {
        keys.v.mod = true;
        const ed = editing(),
          p = lastPointer();
        if (ed?.kind === "note" && !e.repeat) hover(ed.id, document.elementFromPoint(p.x, p.y));
        return;
      }
      const d = mv.v;
      if (!d || d.settling) return;
      const z = modHeld(e) && !e.altKey && e.key.toLowerCase() === "z";
      if (e.key !== "Escape" && !z) return;
      // nothing was written yet: Esc and ⌘Z put it back without an undo step; ⇧⌘Z does nothing
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" || !e.shiftKey) back();
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (modKey(e)) {
        keys.v.mod = false;
        clearHover();
      }
    },
    true,
  );
  window.addEventListener("pointerdown", () => (keys.v.eatClick = false), true);
  // a press that moved blocks is not also a click for the editor or the board (it may end on another element than it began)
  for (const k of ["click", "mousedown"])
    window.addEventListener(
      k,
      (e) => {
        if (!keys.v.eatClick) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (k === "click") keys.v.eatClick = false;
      },
      true,
    );
  window.addEventListener("blur", () => {
    keys.v.mod = false;
    clearHover();
  });
  rooted(() =>
    createEffect(
      on(editing, (ed) => {
        clearHover();
        const d = mv.v;
        if (d && !d.settling) {
          if (ed?.kind === "note" && ed.id === d.src) dropMove();
          else if (!edBlocks(d.src)) {
            // its editor closed: the blocks are found again in the saved Markdown and stay hidden there
            const c = cardById(d.src)?.card;
            const r = c?.kind === "note" && d.part ? findMdBlocks(c.md, d.part.md, d.range[0]) : null;
            if (r) {
              d.range = r;
              d.slots.clear();
              hideStatic(d.src, r);
            } else dropMove();
          }
        }
        if (ed?.kind !== "note") return;
        const id = ed.id;
        const ce = cardEl(id);
        if (!ce) return;
        const ctl = new AbortController();
        const o = { capture: true, signal: ctl.signal };
        ce.addEventListener("pointerdown", (e) => blockDown(id, e), o);
        ce.addEventListener(
          "pointermove",
          (e) => {
            keys.v.mod = modHeld(e);
            hover(id, e.target);
          },
          { signal: ctl.signal, passive: true },
        );
        ce.addEventListener("pointerleave", (e) => e.relatedTarget !== view.box && clearHover(), {
          signal: ctl.signal,
        });
        onCleanup(() => ctl.abort());
      }),
    ),
  );
}
