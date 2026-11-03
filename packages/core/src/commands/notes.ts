// Notes and sidenotes: new Notes, Text, Marks and Boxes, sidenotes added and sidenote ↔ card, images in a Note, Note ↔ Text,
// Split by Headings
import {
  BOX_FILLS,
  type BoxFill,
  type HandColor,
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
  removeSidenotes,
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

/**
 * How a shell measures a code card for keeping it fitted: `measure` = the height of its code area (Place.h) that shows all its
 * content as laid out now, and that content's height (body); `codeMax` = the most a code card without a stored height grows to
 */
export type FitMeasure = { measure(cardId: string): { h: number; body: number } | null; codeMax: number };

/**
 * A change to what a code card shows under its lines (an Always Show sidenote shown, hidden, written or deleted). A card whose
 * stored height fitted its content (Fit Content, or dragged to it) fits it again after the change, in the same undo step: the
 * change is made, the shell lays it out and measures, and the new height is folded into the change's step. As Fit Content,
 * content no taller than codeMax keeps no height. A card without a stored height follows its content anyway; one with a height
 * set by hand that does not fit its content keeps it
 */
function keepFitted(env: CommandEnv, cardId: string, fit: FitMeasure | undefined, change: (b: Board) => void) {
  const b0 = env.board(),
    p0 = b0.place[cardId];
  const fitted =
    fit &&
    p0?.h !== undefined &&
    b0.cards.find((c) => c.id === cardId)?.kind === "code" &&
    Math.abs((fit.measure(cardId)?.h ?? Number.NaN) - p0.h) <= 1;
  const merge = uid("fit");
  if (!env.edit(change, fitted ? { merge } : undefined) || !fitted) return;
  const now = fit.measure(cardId);
  if (!now) return;
  const h = now.body <= fit.codeMax ? undefined : Math.round(now.h);
  if (h === env.board().place[cardId]?.h) return;
  env.edit(
    (b) => {
      const p = b.place[cardId];
      if (p) p.h = h;
    },
    { merge },
  );
}
/** The card an Always Show sidenote shows in, when `id` is one */
const shownIn = (env: CommandEnv, id: string) => {
  const n = env.board().sidenotes.find((k) => k.id === id);
  return n?.kind === "text" && n.alwaysShow ? n.at.card : undefined;
};

/** A Text sidenote's Markdown written; written empty it goes, as a Text sidenote is only its text. Unchanged: no step.
 *  An Always Show one keeps a fitted card fitted (keepFitted) */
export function writeSidenote(env: CommandEnv, id: string, md: string, fit?: FitMeasure) {
  const n0 = env.board().sidenotes.find((k) => k.id === id);
  if (n0?.kind !== "text" || n0.md === md) return;
  const change = (b: Board) => {
    if (!md.trim()) return removeSidenotes(b, [id]);
    const n = b.sidenotes.find((k) => k.id === id);
    if (n?.kind === "text") n.md = md;
  };
  const card = shownIn(env, id);
  if (card) keepFitted(env, card, fit, change);
  else env.edit(change);
}

/** One sidenote deleted; an Always Show one keeps a fitted card fitted (keepFitted) */
export function deleteSidenote(env: CommandEnv, id: string, fit?: FitMeasure) {
  const change = (b: Board) => removeSidenotes(b, [id]);
  const card = shownIn(env, id);
  if (card) keepFitted(env, card, fit, change);
  else env.edit(change);
}

/** An image replaced by the one stored at `src`: an image card's (note left out), or the one at `note` in a Note's Markdown */
export function replaceImage(env: CommandEnv, ref: { card: string; note?: string }, src: string) {
  const old = ref.note;
  env.edit((b) => {
    const c = findCard(b, ref.card)?.card;
    if (old === undefined) {
      if (c?.kind === "image") {
        c.src = src;
        // another picture: the old one's frame means nothing for it
        delete c.frame;
      }
    } else if (c?.kind === "note") c.md = c.md.split(old).join(src);
  });
}

/** The frame an animated image card stands still on, from 1 (null or 1: the first, which is not written) */
export function setImageFrame(env: CommandEnv, id: string, frame: number | null) {
  const f = frameField(frame),
    c0 = imageCardOf(env.board(), id);
  if (!c0 || c0.frame === f) return;
  env.edit((b) => {
    const c = imageCardOf(b, id);
    if (c) c.frame = f;
  });
}

/** An animated image card always plays, or no longer does. frame (as setImageFrame; undefined: kept) goes in the same step, so
 *  turning it off stands it on the frame it stopped on */
export function setImageLoop(env: CommandEnv, id: string, loop: boolean, frame?: number | null) {
  const c0 = imageCardOf(env.board(), id),
    f = frame === undefined ? c0?.frame : frameField(frame);
  if (!c0 || (!!c0.loop === loop && c0.frame === f)) return;
  env.edit((b) => {
    const c = imageCardOf(b, id);
    if (!c) return;
    c.loop = loop || undefined;
    c.frame = f;
  });
}
const frameField = (n: number | null) => (n !== null && n >= 1.5 ? Math.round(n) : undefined);
const imageCardOf = (b: Board, id: string) => {
  const c = findCard(b, id)?.card;
  return c?.kind === "image" ? c : undefined;
};

/** A Note's Markdown replaced as given (a mark toggled, a caption set, Auto Focus's markup); unlike writeNote it never goes */
export function setNoteMarkdown(env: CommandEnv, id: string, md: string) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "note") c.md = md;
  });
}

/** A Mark's colour (its arrows follow it) */
export function setMarkColor(env: CommandEnv, id: string, hand: HandColor) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "note" && c.look === "mark") c.hand = hand;
  });
}

/** A Box's fill */
export function setBoxFill(env: CommandEnv, id: string, fill: BoxFill) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "note" && c.look === "box") c.fill = fill;
  });
}

/** A Text sidenote's Always Show */
export function toggleAlwaysShow(env: CommandEnv, id: string, fit?: FitMeasure) {
  const n0 = env.board().sidenotes.find((k) => k.id === id);
  if (n0?.kind !== "text") return;
  // shown under its lines or not: a card fitted to its content grows or shrinks with it (keepFitted)
  keepFitted(env, n0.at.card, fit, (b) => {
    const n = b.sidenotes.find((k) => k.id === id);
    if (n?.kind === "text") n.alwaysShow = !n.alwaysShow || undefined;
  });
}

/** Board-only: a sidenote on a shared card stays on this board only, or goes along with the card again */
export function toggleBoardOnly(env: CommandEnv, id: string) {
  env.edit((b) => {
    const n = b.sidenotes.find((k) => k.id === id);
    if (n) n.boardOnly = n.boardOnly ? undefined : true;
  });
}

/** A sidenote on changed lines marked as checked */
export function markReviewed(env: CommandEnv, id: string) {
  env.edit((b) => {
    const n = b.sidenotes.find((k) => k.id === id);
    if (n) delete n.review;
  });
}
