// Notes and sidenotes: new Notes, Text, Marks and Boxes, sidenotes added and sidenote ↔ card, images in a Note, Note ↔ Text,
// Split by Headings
import {
  BOX_FILLS,
  findCard,
  isCode,
  uid,
  type Anchor,
  type Board,
  type Card,
  type NoteCard,
  type NoteLook,
  type Sidenote,
} from "../model";
import { NEW_CARD_W, type Rect } from "../layout";
import {
  cardIntoSidenote,
  imageIntoNote,
  sidenoteCard,
  sidenoteToCard,
  splitNoteByHeadings,
  turnNoteInto,
} from "../edit";
import type { CommandEnv } from "./env";

/**
 * Place on Board: a sidenote becomes a card, with an arrow from the line it was on, in one step. add = the shell puts the card on
 * the board where it wants, with `also` in the same step. The card, or null for a sidenote that is a card already
 */
export function sidenoteOnBoard(
  env: CommandEnv,
  noteId: string,
  add: (card: Card, n: Sidenote, also: (b: Board) => void) => void,
): Card | null {
  const n = env.board().sidenotes.find((k) => k.id === noteId);
  if (!n || n.kind === "card") return null;
  const card = sidenoteCard(n);
  if (!card) return null;
  add(card, n, (b) => sidenoteToCard(b, noteId, card.id));
  return card;
}

/**
 * A card dropped on a line becomes a sidenote there: a Note a Text sidenote, a one-segment code card a Code sidenote; a code card
 * with several segments stays and gets a Card sidenote pointing at it. The arrows on the card go with it (asked first)
 */
export async function cardToSidenote(env: CommandEnv, cardId: string, at: Anchor): Promise<boolean> {
  const b = env.board();
  const c = findCard(b, cardId)?.card;
  if (!c) return false;
  const links = b.links.filter((l) => l.from.card === cardId || l.to.card === cardId).length;
  if (links) {
    const ok = await env.choose({
      title: "Turn into a Sidenote?",
      options: ["Turn into Sidenote", "Cancel"],
      text: `${links} link${links > 1 ? "s" : ""} on this card will be deleted.`,
    });
    if (ok !== 0) return false;
  }
  const id = uid("n");
  const n: Sidenote | null =
    isCode(c) && c.segments.length > 1
      ? { id, at, kind: "card", card: cardId }
      : c.kind === "note"
        ? { id, at, kind: "text", md: c.md }
        : isCode(c)
          ? { id, at, kind: "code", code: structuredClone(c.segments[0]), why: c.desc }
          : null;
  if (!n) return false;
  return env.edit((d) => cardIntoSidenote(d, cardId, n));
}

/** An image card dropped on a Note: the image (already stored at `src`) goes into its Markdown at character `at` (a block start;
 *  none = the end) and the image card goes, in one step */
export function putImageInNote(env: CommandEnv, imageId: string, noteId: string, src: string, at?: number): boolean {
  let ok = false;
  return (
    env.edit((b) => {
      ok = imageIntoNote(b, imageId, noteId, src, at);
    }) && ok
  );
}

/** Note ↔ Text */
export function turnNote(env: CommandEnv, id: string, look: "note" | "text") {
  env.edit((b) => turnNoteInto(b, id, look));
}

/**
 * Split by Headings: each heading's part becomes a Note below, linked from the one above it. heights = what the shell measured
 * (the cut Note and each part) for placing them; others = the cards around, kept clear of. The new cards' ids
 */
export function splitByHeadings(
  env: CommandEnv,
  id: string,
  o: { heights?: { root: number; parts: number[] }; others: Rect[] },
): string[] | null {
  let ids: string[] | null = null;
  return env.edit((b) => {
    ids = splitNoteByHeadings(b, id, o);
  })
    ? ids
    : null;
}

/**
 * A new Note, Text, Mark or Box with `text`: a Text is body-sized, a Box gets the first fill and a fixed height, a Mark the colour
 * of the last Mark on the board (blue for the first). Written empty (a Box aside) it is fresh (env.fresh): no undo step until
 * something is written. at(size) = where it goes, for its size (the shell's layout); settle(b, id) files it in the Section it
 * landed in. Its id
 */
export function newWriting(
  env: CommandEnv,
  look: NoteLook,
  text: string,
  o: { at: (size: { w: number; h?: number }) => { x: number; y: number }; settle: (b: Board, id: string) => void },
): string {
  const w = NEW_CARD_W,
    h = look === "box" ? 60 : undefined;
  const p = o.at({ w, h });
  const id = uid("n");
  const card: NoteCard = { id, kind: "note", md: text, look };
  if (look === "text") card.size = "body";
  if (look === "box") card.fill = BOX_FILLS[0];
  if (look === "mark") {
    const last = [...env.board().cards].reverse().find((c) => c.kind === "note" && c.look === "mark");
    card.hand = (last?.kind === "note" && last.hand) || "blue";
  }
  const add = (b: Board) => {
    b.cards.push(card);
    b.place[id] = { x: Math.round(p.x), y: Math.round(p.y), w, ...(h ? { h } : {}) };
    o.settle(b, id);
  };
  if (text || look === "box") env.edit(add);
  else env.fresh.add(id, add);
  return id;
}

/** Add sidenotes in one step; their new ids, in order */
export function addSidenotes(env: CommandEnv, list: Omit<Sidenote, "id">[]): string[] {
  const sns = list.map((n) => ({ ...n, id: uid("n") }) as Sidenote);
  env.edit((b) => {
    b.sidenotes.push(...sns);
  });
  return sns.map((n) => n.id);
}

/** An image replaced by the one stored at `src`: an image card's (note left out), or the one at `note` in a Note's Markdown */
export function replaceImage(env: CommandEnv, ref: { card: string; note?: string }, src: string) {
  const old = ref.note;
  env.edit((b) => {
    const c = findCard(b, ref.card)?.card;
    if (old === undefined) {
      if (c?.kind === "image") c.src = src;
    } else if (c?.kind === "note") c.md = c.md.split(old).join(src);
  });
}
