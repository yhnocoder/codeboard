// Notes and sidenotes: new Notes, Text and Boxes, sidenotes added and sidenote ↔ card, images in a Note, Split by Headings,
// a Text's or Box's size, look (Text ↔ Box) and a Box's fill
import {
  isTextCard,
  scaleText,
  textSizeOf,
  TEXT_SIZES,
  type BoxFill,
  type TextSize,
  cardTitle,
  findCard,
  isCode,
  uid,
  type Anchor,
  type Board,
  type Card,
  type NoteCard,
  type NoteLook,
  type NewSidenote,
  type Sidenote,
} from "../model";
import { NEW_CARD_W, type Rect } from "../layout";
import {
  allLinks,
  cardIntoSidenote,
  imageIntoNote,
  dropOwnHighlight,
  fixHighlights,
  onHighlight,
  removeSidenotes,
  sidenoteCard,
  sidenoteToCard,
  splitNoteByHeadings,
} from "../edit";
import { refSource } from "../mdrefs";
import type { CommandEnv } from "./env";
import { keepFitted, shownUnder, type FitMeasure } from "./fit";

/**
 * Place on Board: a sidenote becomes a card, with an arrow from the line it was on, in one step. add = the shell puts the card on
 * the board where it wants, with `also` in the same step. The card, or null when the sidenote is gone
 */
export function sidenoteOnBoard(
  env: CommandEnv,
  noteId: string,
  add: (card: Card, n: Sidenote, also: (b: Board) => void) => void,
): Card | null {
  const n = env.board().sidenotes.find((k) => k.id === noteId);
  if (!n) return null;
  const card = sidenoteCard(n);
  add(card, n, (b) => sidenoteToCard(b, noteId, card.id));
  return card;
}

/**
 * A card dropped on a line becomes a sidenote there: a Note a Text sidenote, a one-segment code card a Code sidenote; a code card
 * with several segments stays and gets a Text sidenote with a [[reference]] to it, kept on this board only (the card is on this
 * board). The arrows on the card go with it (asked first)
 */
export async function cardToSidenote(env: CommandEnv, cardId: string, at: Anchor): Promise<boolean> {
  const b = env.board();
  const c = findCard(b, cardId)?.card;
  if (!c) return false;
  const links = allLinks(b).filter((l) => l.from.card === cardId || l.to.card === cardId).length;
  if (links) {
    const ok = await env.choose({
      title: "Turn into a Sidenote?",
      options: ["Turn into Sidenote", "Cancel"],
      text: `${links} link${links > 1 ? "s" : ""} on this card will be deleted.`,
    });
    if (ok !== 0) return false;
  }
  const id = uid("n");
  const keep = isCode(c) && c.segments.length > 1;
  const n: Sidenote | null = keep
    ? { id, at, kind: "text", md: refSource(cardTitle(c, b), cardId), boardOnly: true }
    : c.kind === "note"
      ? { id, at, kind: "text", md: c.md }
      : isCode(c)
        ? { id, at, kind: "code", code: structuredClone(c.segments[0]), why: c.desc }
        : null;
  if (!n) return false;
  return env.edit((d) => cardIntoSidenote(d, cardId, n, keep));
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

/** About how wide a new Text's first words are, to centre it where it goes (it is as wide as its text, styles.css) */
const NEW_TEXT_W = 200;
/**
 * A new Note, Text or Box with `text`. Written empty it is fresh (env.fresh): no undo step until something is written, and gone if
 * nothing is. at(size) = where it goes, for its size (the shell's layout); settle(b, id) files it in the Section it landed in. Its id
 */
export function newWriting(
  env: CommandEnv,
  look: NoteLook,
  text: string,
  o: { at: (size: { w: number }) => { x: number; y: number }; settle: (b: Board, id: string) => void },
): string {
  const w = look === "note" ? NEW_CARD_W : NEW_TEXT_W;
  const p = o.at({ w });
  const id = uid("n");
  const card: NoteCard = { id, kind: "note", md: text, look };
  const add = (b: Board) => {
    b.cards.push(card);
    b.place[id] = { x: Math.round(p.x), y: Math.round(p.y), w };
    o.settle(b, id);
  };
  if (text) env.edit(add);
  else env.fresh.add(id, add);
  return id;
}

/**
 * Add sidenotes in one step; their new ids, in order. One on lines goes on the Highlight of those lines, made when there is none;
 * lines that overlap Highlights grow them into one, with the sidenotes on them (addHighlight)
 */
export function addSidenotes(env: CommandEnv, list: NewSidenote[], fit?: FitMeasure): string[] {
  const sns = list.map((n) => ({ ...n, id: uid("n") }) as Sidenote);
  const change = (b: Board) => {
    b.sidenotes.push(...sns);
    for (const n of sns) onHighlight(b, n);
  };
  // a Highlight takes no room; an Always Show one shows under its lines: a fitted card stays fitted
  keepFitted(
    env,
    sns.filter(shownUnder).map((n) => n.at.card),
    fit,
    change,
  );
  return sns.map((n) => n.id);
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

/** One sidenote deleted; an Always Show one keeps a fitted card fitted (keepFitted). A Highlight it leaves, or takes with it, takes
 *  no room */
export function deleteSidenote(env: CommandEnv, id: string, fit?: FitMeasure) {
  const change = (b: Board) => removeSidenotes(b, [id]);
  const card = shownIn(env, id);
  if (card) keepFitted(env, card, fit, change);
  else env.edit(change);
}

/** A card's whole-card sidenotes deleted in one step (they take no room on it); how many went */
export function deleteCardSidenotes(env: CommandEnv, card: string): number {
  const ids = env
    .board()
    .sidenotes.filter((n) => n.at.card === card && !n.at.lines)
    .map((n) => n.id);
  if (ids.length) env.edit((b) => removeSidenotes(b, ids));
  return ids.length;
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

/** A Text's or Box's size picked on its toolbar (S, M, L, XL). One that wraps at a width it was given scales that width with
 *  its text, as dragging its corner does, so it wraps where it did */
export function setTextSize(env: CommandEnv, id: string, size: TextSize) {
  const c0 = findCard(env.board(), id)?.card;
  if (!isTextCard(c0)) return;
  const fs0 = textSizeOf(c0),
    to = TEXT_SIZES[size];
  if (fs0 === to) return;
  env.edit((b) => {
    const f = findCard(b, id),
      c = f?.card,
      p = f && b.place[f.host.id];
    if (!isTextCard(c)) return;
    if (to === TEXT_SIZES.s) delete c.fs;
    else c.fs = to;
    if (p && c.wrap) p.w = scaleText(fs0, p.w, to / fs0).w;
  });
}

/**
 * A Text turned into a Box or a Box into a Text, in one step. A Box takes the fill it had before (yellow the first time). at = where
 * the card goes and its width in the other look, so its text stays where it is (the shell measures it); none = it stays put
 */
export function setTextLook(
  env: CommandEnv,
  id: string,
  look: "text" | "box",
  at?: { x: number; y: number; w: number },
) {
  const c0 = findCard(env.board(), id)?.card;
  if (!isTextCard(c0) || c0.look === look) return;
  env.edit((b) => {
    const f = findCard(b, id),
      c = f?.card,
      p = f && b.place[f.host.id];
    if (!isTextCard(c)) return;
    c.look = look;
    if (p && at) Object.assign(p, { x: hundredths(at.x), y: hundredths(at.y), w: hundredths(at.w) });
  });
}
const hundredths = (v: number) => Math.round(v * 100) / 100;

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
    if (!n) return;
    n.boardOnly = n.boardOnly ? undefined : true;
    // going along with the card again: its lines become (or join) one of the card's Highlights. Made board-only, it takes the
    // card's Highlight it was the only note on, with exactly its lines, along (dropOwnHighlight); one the card shows anyway
    // (others' notes on it, or wider) stays
    if (!n.boardOnly) fixHighlights(b, [n.at.card]);
    else dropOwnHighlight(b, n);
  });
}

/** A sidenote on changed lines marked as checked */
export function markReviewed(env: CommandEnv, id: string) {
  env.edit((b) => {
    const n = b.sidenotes.find((k) => k.id === id);
    if (n) delete n.review;
  });
}
