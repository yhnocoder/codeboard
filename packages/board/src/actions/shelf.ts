// The Shelf (core commands/shelf.ts): Move to Shelf from a menu, a key or a drag onto the dock's Shelf button or the open panel;
// in the panel a thumbnail clicked shows its entry large with Put Back, dragged out it lands where it is let go; Remove. What this
// file adds is the UI: what is selected, the flights into a thumbnail (or the dock button) and back out of a picture of the entry,
// the outlines on the board, the camera
import { unwrap } from "solid-js/store";
import { scrollIntoBox } from "@yhnocoder/markdown/ui";
import {
  bounds,
  estSize,
  findCard,
  nudgeInto,
  shelfPick,
  withCols,
  type Card,
  type Place,
  type Rect,
  type ShelfEntry,
} from "@codeboard/core";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { state, sizes, cardById } from "../state/store";
import { sel, select, clearSel } from "../state/selection";
import { frames, homeFor, deepestAt, isHidden } from "../state/sections";
import { cam, camTarget, camTo } from "../state/camera";
import { boardOffset, worldAt } from "../state/measure";
import { toast } from "../state/toast";
import { animScale, reduceMotion } from "../state/motion";
import { boardRef } from "../state/root";
import {
  setShelfHot,
  setShelfHover,
  setShelfOpen,
  setShelfOut,
  setShelfPeek,
  shelfHover,
  shelfOpen,
  shelfOut,
} from "../state/shelf";
import { attrSel, cardSel } from "../cardsel";
import { track } from "../gesture";
import { openMenu } from "../ui/Menu";

/** How long things fly into a thumbnail or the dock button, or out of a picture of their entry (ms, before the slow-motion factor) */
const FLY_MS = 420;
const EASE_IN = "cubic-bezier(.45,0,.25,1)";
const EASE_OUT = "cubic-bezier(.2,.7,.25,1)";
/** How far in from the edges of the part of the board that is seen the camera brings what was put back (px) */
const SEEN_MARGIN = 24;

const shelfEntries = (): ShelfEntry[] => state.board.shelf ?? [];
const entryOf = (id: string) => shelfEntries().find((e) => e.id === id);

/**
 * An entry's things as they were on the board: its Sections' frames and its cards, at the size the board measured them (this
 * session) or as core estimates a card it has not drawn (with the height kept when it was shelved, Place.mh)
 */
export function entryRects(e: ShelfEntry): {
  sections: (Rect & { id: string; parent?: string })[];
  cards: (Rect & { id: string })[];
} {
  return {
    sections: e.sections.map((s) => ({ id: s.id, parent: s.parent, x: s.x, y: s.y, w: s.w, h: s.h })),
    cards: Object.entries(e.place).map(([id, p]) => {
      const s = sizes[id];
      if (s && s.w > 0 && s.h > 0) return { id, x: p.x, y: p.y, w: s.w, h: s.h };
      const c = cardById(id)?.card;
      return { id, x: p.x, y: p.y, ...(c ? estSize(c, p) : { w: p.w, h: p.h ?? p.mh ?? 120 }) };
    }),
  };
}
/** The box around an entry as it was on the board */
export function entryBox(e: ShelfEntry): Rect | undefined {
  const r = entryRects(e);
  return bounds([...r.sections, ...r.cards]) ?? undefined;
}
/** The Shelf's entries in the order the panel shows them: where they were on the board (core shelfOrder) */
export const shelfInOrder = (): ShelfEntry[] => C.shelfOrder(shelfEntries(), entryBox);

/** The height a card was measured at, kept with it on the Shelf (core shelve): only one that differs from the estimate */
function heightToKeep(c: Card, p: Place): number | undefined {
  const s = sizes[c.id];
  if (!s || s.h <= 0) return;
  const h = Math.round(s.h);
  return h !== estSize(c, { w: p.w }).h ? h : undefined;
}

/**
 * The part of the board that is seen (board px): left of the open Shelf panel, or under it when the panel takes most of the
 * board's width (a narrow window), and above the toolbars at the board's foot
 */
function seenArea(): Rect {
  const o = boardOffset();
  const board = document.getElementById("board")?.getBoundingClientRect();
  const a = { l: 0, t: 0, r: board?.width ?? innerWidth, b: board?.height ?? innerHeight };
  const panel = document.querySelector(".cpanel.shelf")?.getBoundingClientRect();
  if (panel && panel.width > 0) {
    if (panel.left - o.x > a.r / 2) a.r = panel.left - o.x;
    else a.t = Math.max(a.t, panel.bottom - o.y);
  }
  for (const bar of document.querySelectorAll(".over.bbar > .pill, .over.dock > .pill")) {
    const r = bar.getBoundingClientRect();
    if (r.height > 0) a.b = Math.min(a.b, r.top - o.y);
  }
  return { x: a.l, y: a.t, w: Math.max(0, a.r - a.l), h: Math.max(0, a.b - a.t) };
}
/** Where a box of the world is on the board (board px), with the camera c */
const onBoard = (r: Rect, c: { x: number; y: number; z: number } = cam): Rect => ({
  x: c.x + r.x * c.z,
  y: c.y + r.y * c.z,
  w: r.w * c.z,
  h: r.h * c.z,
});

/** A thumbnail's picture of an entry on screen (or, open, the large one beside the panel): its top left and its scale */
type Picture = { x: number; y: number; k: number };
function pictureOf(id: string, box: Rect): Picture | null {
  const q = (s: string) => document.querySelector<HTMLElement>(`${s}${attrSel("data-entry", id)} .shmini`);
  const el = q(".shelf-peek") ?? q(".shthumb");
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 ? { x: r.left, y: r.top, k: r.width / box.w } : null;
}
/** A picture of the entry the size of the dock's Shelf button, on it (none in the narrow layout, which has no dock) */
function dockPicture(box: Rect): Picture | null {
  const r = document.querySelector(".dock .shelf-btn")?.getBoundingClientRect();
  if (!r || !r.width) return null;
  const k = 14 / Math.max(box.w, box.h);
  return { x: r.left + r.width / 2 - (box.w * k) / 2, y: r.top + r.height / 2 - (box.h * k) / 2, k };
}
function bumpDock(delay: number) {
  document
    .querySelector(".dock .shelf-btn")
    ?.animate([{ scale: 1 }, { scale: 1.2 }, { scale: 1 }], { duration: 260 * animScale(), delay, easing: "ease-out" });
}

/** The dock's Shelf button and the open Shelf panel on screen, measured once per drag (neither moves while it lasts): a drag reads
 *  no layout as it moves */
const targets = boardRef<{ dock?: DOMRect; panel?: DOMRect } | null>(null);
const measureTargets = () => {
  const r = (q: string) => {
    const b = document.querySelector(q)?.getBoundingClientRect();
    return b && b.width > 0 ? b : undefined;
  };
  return { dock: r(".dock .shelf-btn"), panel: r(".cpanel.shelf") };
};
/** What a drag at (x, y) on screen is over: the dock's Shelf button, the open Shelf panel, or neither */
function shelfTargetAt(x: number, y: number): "dock" | "panel" | null {
  const t = (targets.v ??= measureTargets());
  const inside = (r?: DOMRect) => !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  return inside(t.dock) ? "dock" : inside(t.panel) ? "panel" : null;
}
/** A drag of cards or Sections moved to (x, y): what it is over, shown on the dock button and the panel */
export function shelfDragAt(x: number, y: number): "dock" | "panel" | null {
  const t = shelfTargetAt(x, y);
  setShelfHot(t ?? "drag");
  return t;
}
export const shelfDragEnd = () => {
  targets.v = null;
  setShelfHot(null);
};

const sectEls = (id: string) => [...document.querySelectorAll<HTMLElement>(`.world ${attrSel("data-sect", id)}`)];
const linkEls = (id: string) =>
  [...document.querySelectorAll<SVGElement>(`.world path.lhit${attrSel("data-link", id)}`)].map(
    (p) => (p.closest("g") ?? p) as SVGElement,
  );
/** A copy of what is on the board left in its place to animate (no events, no ids), removed when its animation ends */
function ghostOf(el: Element): HTMLElement | SVGElement {
  const g = el.cloneNode(true) as HTMLElement;
  for (const x of [g, ...g.querySelectorAll("[data-id],[data-sect],[data-link],[data-lk],[id]")]) {
    for (const a of ["data-id", "data-sect", "data-link", "data-lk", "id"]) x.removeAttribute(a);
  }
  g.classList.remove("sel", "solo", "lift", "landing");
  g.classList.add("shelf-ghost");
  g.setAttribute("data-export", "strip");
  el.after(g);
  return g;
}
/**
 * Moves copies on their way into the open panel onto a layer over the panels, which the board's own layers are under: the world's
 * transform and the layers each copy was in, copied without their content, so the board's styles reach the copies as before. The
 * layer, removed with the copies
 */
function liftOver(gs: Element[]): HTMLElement | null {
  const world = document.querySelector<HTMLElement>(".board > .world");
  const app = world?.closest(".app");
  const board = world?.parentElement;
  if (!world || !app || !board) return null;
  const r = board.getBoundingClientRect();
  const fly = document.createElement("div");
  fly.className = "shelf-fly";
  Object.assign(fly.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  fly.setAttribute("data-export", "strip");
  const top = world.cloneNode(false) as HTMLElement;
  fly.append(top);
  // in the order they are drawn on the board
  const ordered = [...gs].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  for (const g of ordered) {
    let into: Element = top;
    const chain: Element[] = [];
    for (let p = g.parentElement; p && p !== world; p = p.parentElement) chain.unshift(p);
    for (const p of chain) {
      const c = p.cloneNode(false) as Element;
      c.removeAttribute("id");
      into.append(c);
      into = c;
    }
    into.append(g);
  }
  app.append(fly);
  return fly;
}
/** Where an element is on the board, in world coordinates */
function worldRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  const a = worldAt({ x: r.left, y: r.top });
  return { x: a.x, y: a.y, w: r.width / cam.z, h: r.height / cam.z };
}
/** What of these cards and Sections is drawn on the board: cards, Section frames and titles, arrows among them and those leaving */
function drawn(cards: string[], sections: string[]) {
  const all = new Set(withCols(state.board, cards));
  const inner: string[] = [],
    outer: string[] = [];
  for (const l of state.board.links) {
    const a = all.has(l.from.card),
      b = all.has(l.to.card);
    if (a && b) inner.push(l.id);
    else if (a || b) outer.push(l.id);
  }
  const els = sections.flatMap(sectEls);
  return {
    cards: cards.flatMap((id) => [...document.querySelectorAll<HTMLElement>(`.world ${cardSel(id)}`)]),
    frames: els.filter((e) => e.classList.contains("sect")),
    labels: els.filter((e) => !e.classList.contains("sect")),
    inner: inner.flatMap(linkEls),
    outer: outer.flatMap(linkEls),
  };
}
/** The keyframe that puts an element whose world box is r where it is in a picture of its entry (box: the entry's box) */
function inPicture(r: Rect, box: Rect, to: Picture) {
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const at = worldAt({ x: to.x + (c.x - box.x) * to.k, y: to.y + (c.y - box.y) * to.k });
  return { translate: `${at.x - c.x}px ${at.y - c.y}px`, scale: String(to.k / cam.z) };
}

/**
 * The cards, Sections and arrows going onto the Shelf, as drawn now: copies are left in their place (the board changes at once).
 * The function returned flies them into entry `id`'s thumbnail once it is made (null: nothing went), over the panel, the
 * thumbnail fading in under them as they land; with the panel closed, into the dock's Shelf button; with no dock (the narrow
 * layout), they fade where they are
 */
function flyIn(cards: string[], sections: string[]): (id: string | null) => void {
  if (reduceMotion()) return () => {};
  const d = drawn(cards, sections);
  const shapes = [...d.cards, ...d.frames];
  const box = bounds(shapes.map(worldRect));
  const ghosts = [...shapes, ...d.labels, ...d.inner].map((el) => ({ r: worldRect(el), g: ghostOf(el) }));
  const gone = d.outer.map(ghostOf);
  let fly: HTMLElement | null = null;
  const done = () => {
    for (const g of [...ghosts.map((x) => x.g), ...gone]) g.remove();
    fly?.remove();
  };
  return (id) => {
    const e = id ? entryOf(id) : undefined;
    const ebox = e && entryBox(e);
    if (!id || !ebox || !box) return done();
    const thumb = document.querySelector<HTMLElement>(`.shthumb${attrSel("data-entry", id)}`);
    if (thumb) scrollIntoBox(thumb, "nearest");
    const pic = pictureOf(id, ebox);
    const to = pic ?? dockPicture(ebox);
    if (pic) fly = liftOver(ghosts.map((x) => x.g));
    const ms = FLY_MS * animScale();
    // the picture is of the entry as it was put aside, the copies are where they are now (a drag let go elsewhere): the copies'
    // box is fitted into the same picture
    const aim = to && { x: to.x, y: to.y, k: to.k * Math.min(ebox.w / box.w, ebox.h / box.h) };
    if (thumb) thumb.animate([{ opacity: 0 }, { opacity: 0, offset: 0.72 }, { opacity: 1 }], { duration: ms });
    else if (aim) bumpDock(ms * 0.85);
    const runs = ghosts.map(({ r, g }) => {
      g.style.transformOrigin = "50% 50%";
      g.style.transformBox = "fill-box";
      // a card's copy flies over the other cards (frames and arrows stay in their own layers)
      if (g.classList.contains("card")) g.style.zIndex = "60";
      return g.animate(
        [
          { translate: "0 0", scale: "1", opacity: 1 },
          { opacity: 1, offset: 0.72 },
          aim ? { ...inPicture(r, box, aim), opacity: 0 } : { translate: "0 0", scale: "0.9", opacity: 0 },
        ],
        { duration: ms, easing: EASE_IN, fill: "forwards" },
      );
    });
    for (const g of gone)
      runs.push(
        g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.45, easing: "ease-out", fill: "forwards" }),
      );
    void Promise.allSettled(runs.map((a) => a.finished)).then(done);
  };
}

/**
 * What came back onto the board flies out of a picture of its entry (from: where the picture was, box: the entry's box then), or
 * grows where it was dropped (no from); the arrows to the rest of the board fade in as it lands. Run before the next frame is
 * drawn, so it is never seen in place first
 */
function flyOut(cards: string[], sections: string[], from: (Picture & { box: Rect }) | null) {
  if (reduceMotion()) return;
  requestAnimationFrame(() => {
    const d = drawn(cards, sections);
    const ms = FLY_MS * animScale();
    for (const el of [...d.cards, ...d.frames, ...d.labels, ...d.inner]) {
      const start = from
        ? { ...inPicture(worldRect(el), from.box, from), opacity: 0.9 }
        : { translate: "0 0", scale: "0.96", opacity: 0 };
      const on = {
        transformOrigin: "50% 50%",
        transformBox: "fill-box",
        ...(el.classList.contains("card") ? { zIndex: "60" } : {}),
      };
      el.animate(
        [
          { ...start, ...on },
          { translate: "0 0", scale: "1", opacity: 1, ...on },
        ],
        { duration: ms, easing: EASE_OUT },
      );
    }
    for (const el of d.outer)
      el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], { duration: ms * 1.3 });
  });
}

/** Moved to Shelf with the panel closed: said, since only the dock button's count shows it (or nothing, in the narrow layout) */
function told(cards: number, sections: number) {
  if (shelfOpen()) return;
  toast(!sections && cards > 1 ? `Moved ${cards} cards to Shelf` : "Moved to Shelf");
}

/**
 * Move to Shelf: these cards and Sections (a Section with its cards and inner Sections) go onto the Shelf as one entry, flying
 * into its thumbnail. Whether anything went
 */
function shelveThese(cards: string[], sections: string[]): boolean {
  const pick = shelfPick(unwrap(state.board), { cards, sections });
  if (!pick.cards.length && !pick.sections.length) return false;
  const land = flyIn(pick.cards, pick.sections);
  const id = C.shelve(commandEnv, { ...pick, keep: heightToKeep });
  land(id);
  if (!id) return false;
  clearSel();
  told(pick.cards.length, pick.sections.length);
  return true;
}
/** Move to Shelf (menu, ⌥S): what is selected; hidden cards (in a folded call tree) stay */
export function shelveSel() {
  shelveThese(
    sel.cards.filter((id) => !isHidden(id)),
    [...sel.sections],
  );
}
/**
 * A drag let go over the dock button or the panel: the dragged things fly in from where they were let go, then go back (restore,
 * part of the drag's step) and onto the Shelf (the function returned, a step of its own), so the entry keeps where they were
 */
export function shelveDragged(cards: string[], sections: string[], restore: () => void) {
  const pick = shelfPick(unwrap(state.board), { cards, sections });
  const land = flyIn(pick.cards, pick.sections);
  restore();
  return () => {
    const id = pick.cards.length || pick.sections.length ? C.shelve(commandEnv, { ...pick, keep: heightToKeep }) : null;
    land(id);
    if (!id) return;
    clearSel();
    told(pick.cards.length, pick.sections.length);
  };
}

/**
 * Put Back (the large picture's button, a thumbnail's menu, a search hit): the entry goes back where it was, in front of the cards
 * there (core putBack), selected, flying out of its picture. The camera keeps its zoom; it pans only when where the entry returns
 * to is not wholly in the part of the board that is seen, by the least that brings it in (core nudgeInto)
 */
export function putBack(id: string): boolean {
  const e = entryOf(id);
  const box = e && entryBox(e);
  if (!e || !box) return false;
  const pic = pictureOf(id, box) ?? dockPicture(box);
  const seen = seenArea();
  setShelfHover(null);
  setShelfPeek(null);
  const back = C.putBack(commandEnv, id);
  if (!back) return false;
  select(back.sections.length ? { sections: back.sections } : { cards: back.cards });
  const c = camTarget();
  const { dx, dy } = nudgeInto(onBoard(box, c), seen, SEEN_MARGIN);
  if (dx || dy) camTo(c.x + dx, c.y + dy, c.z);
  flyOut(back.cards, back.sections, pic && { ...pic, box });
  return true;
}

/** A search hit on a card that is on the Shelf: its whole entry comes back (Put Back), and the card is selected. Whether it was */
export function takeOutCard(card: string): boolean {
  const host = findCard(state.board, card)?.host.id ?? card;
  const e = shelfEntries().find((x) => withCols(state.board, Object.keys(x.place)).includes(host));
  if (!e || !putBack(e.id)) return false;
  select({ cards: [card] });
  return true;
}

/** An entry dropped on the board with its top left at `at` (world): its layout as it was, in the Sections it lands in */
function dropEntry(id: string, at: { x: number; y: number }) {
  const e = entryOf(id);
  const box = e && entryBox(e);
  if (!e || !box) return;
  const dx = Math.round(at.x - box.x),
    dy = Math.round(at.y - box.y);
  const own = new Set(e.sections.map((s) => s.id));
  const fr = frames();
  const into: Record<string, string | undefined> = {};
  const r = entryRects(e);
  for (const c of r.cards)
    if (!own.has(e.place[c.id].section ?? "")) into[c.id] = homeFor(fr, { ...c, x: c.x + dx, y: c.y + dy })?.id;
  for (const s of r.sections)
    if (!s.parent || !own.has(s.parent)) into[s.id] = deepestAt(fr, s.x + dx + 16, s.y + dy + 16)?.id;
  const back = C.putBack(commandEnv, id, { dx, dy, into });
  if (!back) return;
  select(back.sections.length ? { sections: back.sections } : { cards: back.cards });
  flyOut(back.cards, back.sections, null);
}

/** Remove (a thumbnail's menu): the entry and everything in it are deleted; ⌘Z brings them back onto the Shelf */
function removeEntry(id: string) {
  if (C.removeFromShelf(commandEnv, id)) toast("Removed from Shelf");
}

export function toggleShelf(v?: boolean) {
  setShelfOpen((o) => v ?? !o);
  if (!shelfOpen()) {
    setShelfPeek(null);
    setShelfHover(null);
  }
}
/** A thumbnail clicked: its entry shown large beside the panel; clicked again, that goes */
const togglePeek = (id: string) => setShelfPeek((p) => (p === id ? null : id));

/** The pointer came onto a thumbnail: the board outlines where its entry returns to (ui/ShelfPanel.tsx ShelfOutline) */
export function hoverThumb(id: string) {
  if (!shelfOut() && shelfHover()?.id !== id) setShelfHover({ id, seen: seenArea() });
}
export function leaveThumb(id: string) {
  if (shelfHover()?.id === id) setShelfHover(null);
}
/** Whether any of where an entry returns to (a world box) is in the part of the board that is seen (board px) */
export const partSeen = (box: Rect, seen: Rect): boolean => {
  const r = onBoard(box);
  return r.x < seen.x + seen.w && r.y < seen.y + seen.h && r.x + r.w > seen.x && r.y + r.h > seen.y;
};

/** A thumbnail's menu */
export function shelfThumbMenu(e: MouseEvent, id: string) {
  e.preventDefault();
  e.stopPropagation();
  openMenu(
    [
      { label: "Put Back", run: () => putBack(id) },
      null,
      { label: "Remove", hint: "Delete it and what is in it", danger: true, run: () => removeEntry(id) },
    ],
    e.clientX,
    e.clientY,
  );
}

/**
 * A thumbnail pressed: let go where it was, its entry is shown large (togglePeek). Dragged out over the board, a dashed outline of
 * the entry (as it was laid out) follows the pointer, held where the picture was grabbed; let go there, the entry is put on the
 * board and the camera stays. Let go over the panel: nothing happens
 */
export function shelfThumbDown(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  const ent = entryOf(id);
  const box = ent && entryBox(ent);
  if (!ent || !box) return;
  e.preventDefault();
  const pic = pictureOf(id, box);
  const gx = pic ? Math.min(box.w, Math.max(0, (e.clientX - pic.x) / pic.k)) : 0,
    gy = pic ? Math.min(box.h, Math.max(0, (e.clientY - pic.y) / pic.k)) : 0;
  targets.v = null;
  const end = () => {
    setShelfOut(null);
    targets.v = null;
  };
  track(
    e,
    (ev) => {
      setShelfHover(null);
      setShelfPeek(null);
      if (shelfTargetAt(ev.clientX, ev.clientY) === "panel") return setShelfOut({ id });
      const w = worldAt({ x: ev.clientX, y: ev.clientY });
      setShelfOut({ id, at: { x: Math.round(w.x - gx), y: Math.round(w.y - gy) } });
    },
    (_ev, moved) => {
      const o = shelfOut();
      end();
      if (!moved) togglePeek(id);
      else if (o?.at) dropEntry(id, o.at);
    },
    undefined,
    end,
  );
}
