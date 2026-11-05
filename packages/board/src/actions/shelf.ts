// The Shelf (core commands/shelf.ts): Move to Shelf from a menu, a key or a drag onto the dock's Shelf button or the open panel,
// Put Back, dragging an entry out of the panel onto the board, Remove. What this file adds is the UI: what is selected, the
// flight into the dock button and back, the outline that follows the pointer, the camera
import { unwrap } from "solid-js/store";
import { bounds, shelfPick, type Rect, type ShelfEntry } from "@codeboard/core";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { state, sizes } from "../state/store";
import { sel, select, clearSel } from "../state/selection";
import { frames, homeFor, deepestAt, isHidden } from "../state/sections";
import { cam, camTarget, camTo, fitRect, view } from "../state/camera";
import { worldAt } from "../state/measure";
import { toast } from "../state/toast";
import { animScale, reduceMotion } from "../state/motion";
import { setShelfOpen, setShelfOut, shelfOut, setShelfHot } from "../state/shelf";
import { cardSel } from "../cardsel";
import { track } from "../gesture";
import { openMenu } from "../ui/Menu";

/** How long things fly into the dock's Shelf button, or out of it on Put Back (ms, before the slow-motion factor) */
const FLY_MS = 380;

const shelfEntries = (): ShelfEntry[] => state.board.shelf ?? [];
const entryOf = (id: string) => shelfEntries().find((e) => e.id === id);

/** An entry's things as they were on the board: its Sections' frames and its cards (their measured size while known) */
export function entryRects(e: ShelfEntry): {
  sections: (Rect & { id: string; parent?: string })[];
  cards: (Rect & { id: string })[];
} {
  return {
    sections: e.sections.map((s) => ({ id: s.id, parent: s.parent, x: s.x, y: s.y, w: s.w, h: s.h })),
    cards: Object.entries(e.place).map(([id, p]) => {
      const s = sizes[id];
      return { id, x: p.x, y: p.y, w: s && s.w > 0 ? s.w : p.w, h: s && s.h > 0 ? s.h : (p.h ?? p.mh ?? 120) };
    }),
  };
}
/** The box around an entry as it was on the board */
export function entryBox(e: ShelfEntry): Rect | undefined {
  const r = entryRects(e);
  return bounds([...r.sections, ...r.cards]) ?? undefined;
}

/** What a drag at (x, y) on screen is over: the dock's Shelf button, the open Shelf panel, or neither */
function shelfTargetAt(x: number, y: number): "dock" | "panel" | null {
  const inside = (q: string) => {
    const el = document.querySelector(q);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  return inside(".dock .shelf-btn") ? "dock" : inside(".cpanel.shelf") ? "panel" : null;
}
/** A drag of cards or Sections moved to (x, y): what it is over, shown on the dock button and the panel */
export function shelfDragAt(x: number, y: number): "dock" | "panel" | null {
  const t = shelfTargetAt(x, y);
  setShelfHot(t ?? "drag");
  return t;
}
export const shelfDragEnd = () => setShelfHot(null);

/** Where the dock's Shelf button is, in world coordinates (none in the narrow layout: then things fade where they are) */
function dockPoint(): { x: number; y: number } | null {
  const el = document.querySelector(".dock .shelf-btn");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return worldAt({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
}
const sectEls = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-sect="${CSS.escape(id)}"]`)];
const linkEls = (id: string) =>
  [...document.querySelectorAll(`path.lhit[data-link="${CSS.escape(id)}"]`)].map((p) => p.closest("g") ?? p);
/** A copy of what is on the board left in its place to animate (no events, no ids), removed when its animation ends */
function ghostOf(el: Element): HTMLElement | SVGElement {
  const g = el.cloneNode(true) as HTMLElement;
  for (const x of [g, ...g.querySelectorAll("[data-id],[data-sect],[data-link],[data-lk],[id]")]) {
    for (const a of ["data-id", "data-sect", "data-link", "data-lk", "id"]) x.removeAttribute(a);
  }
  g.classList.remove("sel");
  g.classList.add("shelf-ghost");
  g.setAttribute("data-export", "strip");
  el.after(g);
  return g;
}
/** The center of an element on the board, in world coordinates */
function worldCenter(el: Element) {
  const r = el.getBoundingClientRect();
  return worldAt({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
}
function bumpDock(delay: number) {
  document
    .querySelector(".dock .shelf-btn")
    ?.animate([{ scale: 1 }, { scale: 1.2 }, { scale: 1 }], { duration: 260 * animScale(), delay, easing: "ease-out" });
}

/** The cards, Sections and arrows going onto the Shelf shrink and fly into the dock's Shelf button (copies: the board changes at once) */
function flyIn(cards: string[], sections: string[], links: string[]) {
  if (reduceMotion()) return;
  const to = dockPoint();
  const ms = FLY_MS * animScale();
  const els = [...cards.flatMap((id) => [...document.querySelectorAll(cardSel(id))]), ...sections.flatMap(sectEls)];
  for (const el of els) {
    const c = worldCenter(el);
    const g = ghostOf(el);
    g.style.transformOrigin = "50% 50%";
    g.style.pointerEvents = "none";
    const end = to
      ? { translate: `${to.x - c.x}px ${to.y - c.y}px`, scale: "0.04", opacity: 0.3 }
      : { translate: "0 0", scale: "0.9", opacity: 0 };
    g.animate([{ translate: "0 0", scale: "1", opacity: 1 }, end], {
      duration: ms,
      easing: "cubic-bezier(.55,0,.8,.3)",
      fill: "forwards",
    }).finished.then(
      () => g.remove(),
      () => g.remove(),
    );
  }
  for (const el of links.flatMap(linkEls)) {
    const g = ghostOf(el);
    g.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: ms * 0.6,
      easing: "ease-out",
      fill: "forwards",
    }).finished.then(
      () => g.remove(),
      () => g.remove(),
    );
  }
  if (to && els.length) bumpDock(ms * 0.85);
}

/**
 * What came back onto the board appears: out of the dock's Shelf button (Put Back) or grown where it was dropped. Run once it is
 * drawn (the next frame)
 */
function flyOut(cards: string[], sections: string[], fromDock: boolean) {
  if (reduceMotion()) return;
  requestAnimationFrame(() => {
    const from = fromDock ? dockPoint() : null;
    const ms = FLY_MS * animScale();
    const els = [...cards.flatMap((id) => [...document.querySelectorAll(cardSel(id))]), ...sections.flatMap(sectEls)];
    for (const el of els) {
      const c = worldCenter(el);
      const start = from
        ? { translate: `${from.x - c.x}px ${from.y - c.y}px`, scale: "0.04", opacity: 0.3 }
        : { translate: "0 0", scale: "0.96", opacity: 0 };
      (el as HTMLElement).animate(
        [
          { ...start, transformOrigin: "50% 50%" },
          { translate: "0 0", scale: "1", opacity: 1, transformOrigin: "50% 50%" },
        ],
        {
          duration: ms,
          easing: "cubic-bezier(.2,.7,.3,1)",
        },
      );
    }
  });
}

/**
 * Move to Shelf: these cards and Sections (a Section with its cards and inner Sections) go onto the Shelf as one entry, flying
 * into the dock button. fly = false: the caller animated them already. Whether anything went
 */
function shelveThese(cards: string[], sections: string[], fly = true): boolean {
  const pick = shelfPick(unwrap(state.board), { cards, sections });
  if (!pick.cards.length && !pick.sections.length) return false;
  if (fly) {
    const ids = new Set(pick.cards);
    flyIn(
      pick.cards,
      pick.sections,
      state.board.links.filter((l) => ids.has(l.from.card) || ids.has(l.to.card)).map((l) => l.id),
    );
  }
  if (!C.shelve(commandEnv, { cards: pick.cards, sections: pick.sections })) return false;
  clearSel();
  toast(
    pick.sections.length
      ? "Moved to Shelf"
      : pick.cards.length > 1
        ? `Moved ${pick.cards.length} cards to Shelf`
        : "Moved to Shelf",
  );
  return true;
}
/** Move to Shelf (menu, ⌥S): what is selected; hidden cards (in a folded call tree) stay */
export function shelveSel() {
  shelveThese(
    sel.cards.filter((id) => !isHidden(id)),
    [...sel.sections],
  );
}
/** A drag let go over the Shelf: the dragged things fly in from where they are now, then go back (restore) and onto the Shelf */
export function shelveDragged(cards: string[], sections: string[], restore: () => void) {
  const pick = shelfPick(unwrap(state.board), { cards, sections });
  const ids = new Set(pick.cards);
  flyIn(
    pick.cards,
    pick.sections,
    state.board.links.filter((l) => ids.has(l.from.card) || ids.has(l.to.card)).map((l) => l.id),
  );
  restore();
  return () => shelveThese(cards, sections, false);
}

/** The camera shows this box (world) if it is not on screen already: it pans there, zooming out only when it has to */
function bringIntoView(r: Rect) {
  const z = cam.z,
    v = view();
  const x0 = -cam.x / z,
    y0 = -cam.y / z,
    x1 = x0 + v.w / z,
    y1 = y0 + v.h / z;
  if (r.x >= x0 && r.y >= y0 && r.x + r.w <= x1 && r.y + r.h <= y1) return;
  const f = fitRect(r, camTarget().z);
  camTo(f.x, f.y, f.z);
}

/** Put Back: the entry goes back where it was (the camera follows when that is off screen), flying out of the dock button */
export function putBack(id: string) {
  const e = entryOf(id);
  if (!e) return;
  const box = entryBox(e);
  const back = C.putBack(commandEnv, id);
  if (!back) return;
  if (box) bringIntoView(box);
  select(back.sections.length ? { sections: back.sections } : { cards: back.cards });
  flyOut(back.cards, back.sections, true);
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
  flyOut(back.cards, back.sections, false);
}

/** Remove (a row's menu): the entry and everything in it are deleted; ⌘Z brings them back onto the Shelf */
function removeEntry(id: string) {
  if (C.removeFromShelf(commandEnv, id)) toast("Removed from Shelf");
}

export function toggleShelf(v?: boolean) {
  setShelfOpen((o) => v ?? !o);
}

/** A row's menu */
export function shelfRowMenu(e: MouseEvent, id: string) {
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
 * A row pressed: dragged out over the board, a dashed outline of the entry (as it was laid out) follows the pointer, held by its
 * top left; let go there, the entry is put on the board. Let go over the panel: nothing happens
 */
export function shelfRowDown(e: PointerEvent, id: string) {
  if (e.button !== 0 || (e.target as Element).closest("button")) return;
  const ent = entryOf(id);
  if (!ent || !entryBox(ent)) return;
  e.preventDefault();
  // the grab point: just inside the outline's top left, the same on screen at any zoom
  const gx = 28 / cam.z,
    gy = 14 / cam.z;
  track(
    e,
    (ev) => {
      if (shelfTargetAt(ev.clientX, ev.clientY) === "panel") return setShelfOut({ id });
      const w = worldAt({ x: ev.clientX, y: ev.clientY });
      setShelfOut({ id, at: { x: Math.round(w.x - gx), y: Math.round(w.y - gy) } });
    },
    (_ev, moved) => {
      const o = shelfOut();
      setShelfOut(null);
      if (moved && o?.at) dropEntry(id, o.at);
    },
    undefined,
    () => setShelfOut(null),
  );
}
