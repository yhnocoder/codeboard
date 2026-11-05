// The board's Shelf: cards and Sections put aside, kept with the board but off the canvas (model.ts ShelfEntry). Putting things
// on the Shelf and taking them back are moves between the board's collections and an entry; nothing is copied or renamed, so a
// shared card, its twins, its sidenotes and its creation order stay as they were.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import { removeCards } from "./refs";
import { tidyShelf } from "./internal";
import { findCard, type Board, type Link, type ShelfEntry, type Sticker } from "../model";

/** Every card on the Shelf: the shelved ones and a shelved Compare's columns */
export function shelvedCards(b: Pick<Board, "cards" | "shelf">): Set<string> {
  const out = new Set<string>();
  for (const e of b.shelf ?? []) for (const id of Object.keys(e.place)) out.add(id);
  if (out.size) for (const c of b.cards) if (c.kind === "compare" && out.has(c.id)) for (const k of c.cols) out.add(k);
  return out;
}

/**
 * What putting these on the Shelf takes: the Sections with all their inner Sections (in board order), the cards in them and the
 * cards given (a Compare's column: its Compare), only what is on the canvas
 */
export function shelfPick(
  b: Pick<Board, "cards" | "place" | "sections">,
  o: { cards?: Iterable<string>; sections?: Iterable<string> },
): { cards: string[]; sections: string[] } {
  const secs = new Set([...(o.sections ?? [])].filter((id) => b.sections.some((s) => s.id === id)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of b.sections)
      if (s.parent && secs.has(s.parent) && !secs.has(s.id)) {
        secs.add(s.id);
        grew = true;
      }
  }
  const cards = new Set<string>();
  for (const id of o.cards ?? []) {
    const h = findCard(b, id)?.host.id;
    if (h && b.place[h]) cards.add(h);
  }
  for (const c of b.cards) {
    const p = b.place[c.id];
    if (p?.section && secs.has(p.section)) cards.add(c.id);
  }
  return {
    cards: b.cards.filter((c) => cards.has(c.id)).map((c) => c.id),
    sections: b.sections.filter((s) => secs.has(s.id)).map((s) => s.id),
  };
}

/**
 * Put these cards and Sections (with what is in them, shelfPick) on the Shelf as one new entry `id`, shelved at `at`: their places
 * and the Sections leave the canvas, and so do the arrows touching those cards and the stickers on the cards and on those arrows.
 * The entry, or null when there is nothing on the canvas to shelve
 */
export function shelveItems(
  b: Board,
  o: { id: string; at: number; cards?: Iterable<string>; sections?: Iterable<string> },
): ShelfEntry | null {
  const pick = shelfPick(b, o);
  if (!pick.cards.length && !pick.sections.length) return null;
  const hosts = new Set(pick.cards);
  const all = new Set(pick.cards);
  for (const c of b.cards) if (c.kind === "compare" && hosts.has(c.id)) for (const k of c.cols) all.add(k);
  const secs = new Set(pick.sections);
  const e: ShelfEntry = { id: o.id, at: o.at, place: {}, sections: [], links: [], stickers: [] };
  for (const id of pick.cards) {
    e.place[id] = b.place[id];
    delete b.place[id];
  }
  e.sections = b.sections.filter((s) => secs.has(s.id));
  b.sections = b.sections.filter((s) => !secs.has(s.id));
  const touches = (l: Link) => all.has(l.from.card) || all.has(l.to.card);
  e.links = b.links.filter(touches);
  b.links = b.links.filter((l) => !touches(l));
  const moved = new Set(e.links.map((l) => l.id));
  const goes = (k: Sticker) => {
    const at = k.at;
    if (at.kind === "line") return all.has(at.card);
    return !!at.on && ("card" in at.on ? all.has(at.on.card) : moved.has(at.on.link));
  };
  e.stickers = b.stickers.filter(goes);
  b.stickers = b.stickers.filter((k) => !goes(k));
  (b.shelf ??= []).push(e);
  return e;
}

/**
 * Take entry `id` off the Shelf, back onto the canvas: moved by (dx, dy) (none: where it was). A Section or card that was in a
 * Section left on the board goes back into it when it returns to its place and that Section is still there; moved elsewhere it is
 * in none, or in the one `into` gives it (by card or Section id: the Section the shell found where it lands). The entry, or null
 * when there is none
 */
export function unshelve(
  b: Board,
  id: string,
  o: { dx?: number; dy?: number; into?: Record<string, string | undefined> } = {},
): ShelfEntry | null {
  const e = b.shelf?.find((x) => x.id === id);
  if (!e) return null;
  b.shelf = b.shelf!.filter((x) => x !== e);
  const dx = Math.round(o.dx ?? 0),
    dy = Math.round(o.dy ?? 0);
  const moved = dx !== 0 || dy !== 0;
  const own = new Set(e.sections.map((s) => s.id));
  const board = new Set(b.sections.map((s) => s.id));
  const keep = (sec?: string) => !!sec && (own.has(sec) || (!moved && board.has(sec)));
  const home = (k: string, now?: string) => {
    if (keep(now)) return now;
    const to = o.into?.[k];
    return to && board.has(to) ? to : undefined;
  };
  for (const s of e.sections) {
    s.x += dx;
    s.y += dy;
    const p = home(s.id, s.parent);
    if (p) s.parent = p;
    else delete s.parent;
    b.sections.push(s);
  }
  for (const [cid, p] of Object.entries(e.place)) {
    p.x += dx;
    p.y += dy;
    const sec = home(cid, p.section);
    if (sec) p.section = sec;
    else delete p.section;
    b.place[cid] = p;
  }
  b.links.push(...e.links);
  b.stickers.push(...e.stickers);
  tidyShelf(b);
  return e;
}

/** Delete entry `id` from the Shelf and everything in it (its cards as Delete deletes them: removeCards) */
export function removeShelfEntry(b: Board, id: string): void {
  const e = b.shelf?.find((x) => x.id === id);
  if (!e) return;
  b.shelf = b.shelf!.filter((x) => x !== e);
  tidyShelf(b);
  removeCards(b, Object.keys(e.place));
}
