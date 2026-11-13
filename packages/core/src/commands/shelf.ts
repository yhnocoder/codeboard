// The Shelf (edit/shelf.ts): putting cards and Sections aside, taking them back where they were or where the shell drops them,
// deleting what is on it, the order the Shelf shows its entries in, and what an entry is called
import { arrangeCards, removeShelfEntry, shelveItems, unshelve } from "../edit";
import type { Rect } from "../layout";
import {
  baseName,
  cardTitle,
  domainOf,
  uid,
  withCols,
  type Board,
  type Card,
  type NoteLook,
  type Place,
  type ShelfEntry,
} from "../model";
import type { CommandEnv } from "./env";

/**
 * Move to Shelf: these cards and Sections (each Section with its cards and inner Sections) go onto the Shelf as one entry, in one
 * step. keep(c, p) = the height the shell measured of a card to keep with it (Place.mh), so that where it returns to is known
 * after a reload too. The new entry's id, or null when none of them is on the canvas
 */
export function shelve(
  env: CommandEnv,
  o: { cards?: Iterable<string>; sections?: Iterable<string>; keep?: (c: Card, p: Place) => number | undefined },
): string | null {
  const id = uid("sh");
  let made = false;
  const cards = [...(o.cards ?? [])],
    sections = [...(o.sections ?? [])];
  env.edit((b) => {
    const e = shelveItems(b, { id, at: Date.now(), cards, sections });
    made = !!e;
    if (e && o.keep)
      for (const c of b.cards) {
        const p = e.place[c.id],
          mh = p && !p.h ? o.keep(c, p) : undefined;
        if (mh) p.mh = mh;
      }
  });
  return made ? id : null;
}

/**
 * Put Back (no offset: where it was) or drop an entry on the board, moved by (dx, dy), in one step. into: the Sections the shell
 * found where moved cards and outer Sections land (edit/shelf.ts unshelve). Its cards come back in front of every card on the
 * board, so one made where they were while they were away does not cover them. The ids that came back (cards and Sections), or
 * null
 */
export function putBack(
  env: CommandEnv,
  id: string,
  o: { dx?: number; dy?: number; into?: Record<string, string | undefined> } = {},
): { cards: string[]; sections: string[] } | null {
  let out: { cards: string[]; sections: string[] } | null = null;
  env.edit((b) => {
    const e = unshelve(b, id, o);
    if (!e) return;
    arrangeCards(b, withCols(b, Object.keys(e.place)), "front", () => true);
    out = { cards: Object.keys(e.place), sections: e.sections.map((s) => s.id) };
  });
  return out;
}

/** Remove from the Shelf: the entry and everything in it are deleted (as Delete deletes cards), in one step */
export function removeFromShelf(env: CommandEnv, id: string): boolean {
  if (!env.board().shelf?.some((e) => e.id === id)) return false;
  return env.edit((b) => removeShelfEntry(b, id));
}

const LOOK: Record<NoteLook, string> = { note: "Note", text: "Text", box: "Box" };
/** A card's kind as a Shelf row writes it: Note, Code · model_runner.py, Web · github.com… */
function kindOf(c: Card): string {
  switch (c.kind) {
    case "code": {
      const s = c.segments[0];
      return s && s.src.kind !== "free" && s.path ? `Code · ${baseName(s.path)}` : "Code";
    }
    case "note":
      return LOOK[c.look];
    case "image":
      return "Image";
    case "web":
      return `Web · ${domainOf(c.url)}`;
    case "links":
      return "Link List";
    case "compare":
      return "Compare";
    case "board":
      return "Board";
  }
}
/**
 * The order the Shelf shows its entries in: where they were on the board, as it is read. Rows from the top (an entry whose top is
 * above the middle of a row's first entry is in that row), each from the left. box = an entry's box on the board (none: left out)
 */
export function shelfOrder(entries: readonly ShelfEntry[], box: (e: ShelfEntry) => Rect | undefined): ShelfEntry[] {
  const boxed = entries.flatMap((e) => {
    const r = box(e);
    return r ? [{ e, r }] : [];
  });
  boxed.sort((p, q) => p.r.y - q.r.y || p.r.x - q.r.x);
  const rows: { mid: number; items: typeof boxed }[] = [];
  for (const it of boxed) {
    const row = rows.at(-1);
    if (row && it.r.y < row.mid) row.items.push(it);
    else rows.push({ mid: it.r.y + it.r.h / 2, items: [it] });
  }
  return rows.flatMap((row) => row.items.sort((p, q) => p.r.x - q.r.x).map((it) => it.e));
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * What a Shelf row says about an entry: its title (the outermost Section's, or the card's; several cards: the first one's) and its
 * kind line: "Section · 2 cards · 1 arrow", "Note", "Code · model_runner.py", "3 cards · 2 arrows"
 */
export function shelfLabel(b: Pick<Board, "cards">, e: ShelfEntry): { title: string; kind: string } {
  const ids = new Set(Object.keys(e.place));
  const cards = b.cards.filter((c) => ids.has(c.id));
  const arrows = e.links.filter((l) => ids.has(l.from.card) && ids.has(l.to.card)).length;
  const more = [count(cards.length, "card"), ...(arrows ? [count(arrows, "arrow")] : [])];
  const top = e.sections.find((s) => !s.parent || !e.sections.some((q) => q.id === s.parent));
  if (top) {
    const tops = e.sections.filter((s) => !s.parent || !e.sections.some((q) => q.id === s.parent)).length;
    return { title: top.title, kind: [tops > 1 ? count(tops, "Section") : "Section", ...more].join(" · ") };
  }
  if (cards.length === 1) return { title: cardTitle(cards[0], b), kind: kindOf(cards[0]) };
  return { title: cards[0] ? cardTitle(cards[0], b) : "Cards", kind: more.join(" · ") };
}
