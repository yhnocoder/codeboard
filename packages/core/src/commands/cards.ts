// Cards, links and Sections as a whole: delete, stack, duplicate, rename, Compare, merge and split, unlink, new Sections
import {
  cardTitle,
  findCard,
  isCode,
  uid,
  type Board,
  type Card,
  type CodeCard,
  type NoteCard,
  type NoteLayout,
  type Place,
  type Section,
  type Segment,
} from "../model";
import { defaultWidth, estSize, GAP, type Rect } from "../layout";
import {
  arrangeCards,
  makeCompare,
  mergeCodeCards,
  placeCards,
  removeCards,
  removeLinks,
  removeSections,
  removeSidenotes,
  removeStickers,
  renameTitleRefs,
  replaceCards,
  retargetCards,
  unlinkCard,
  unmergeCard,
  type Arrange,
  type CardCopy,
} from "../edit";
import { sharedOn, type CommandEnv } from "./env";

/** Delete these items, with what hangs on them (arrows, sidenotes and stickers on deleted cards; a Section's cards stay) */
export function deleteItems(
  env: CommandEnv,
  o: {
    cards?: Iterable<string>;
    links?: Iterable<string>;
    sections?: Iterable<string>;
    sidenotes?: Iterable<string>;
    stickers?: Iterable<string>;
  },
): boolean {
  return env.edit((b) => {
    if (o.cards) removeCards(b, o.cards);
    if (o.links) removeLinks(b, o.links);
    if (o.sections) removeSections(b, o.sections);
    if (o.sidenotes) removeSidenotes(b, o.sidenotes);
    if (o.stickers) removeStickers(b, o.stickers);
  });
}

/** Stacking order (Bring Forward …): forward / backward pass only the cards `overlaps` says overlap them */
export function arrange(env: CommandEnv, ids: Set<string>, how: Arrange, overlaps: (id: string) => boolean) {
  env.edit((b) => arrangeCards(b, ids, how, overlaps));
}

/**
 * Duplicate: copies with new card and segment ids, placed 48 px down and right, without folding or locks and without arrows.
 * The copies' ids in the order given and the segments' new ids (old → new), or null when the edit failed
 */
export function duplicateCards(
  env: CommandEnv,
  ids: string[],
): { made: string[]; segs: Record<string, string> } | null {
  const b0 = env.board();
  const items: CardCopy[] = ids.flatMap((id) => {
    const c = b0.cards.find((k) => k.id === id);
    return c ? [{ card: c, place: b0.place[id] }] : [];
  });
  let made: string[] = [],
    segs: Record<string, string> = {};
  const ok = env.edit((b) => {
    const r = placeCards(b, items, { copy: true, at: (p) => ({ ...p, x: p.x + 48, y: p.y + 48 }) });
    made = items.map((it) => r.cards[it.card.id]);
    segs = r.segs;
  });
  return ok ? { made, segs } : null;
}

/** Rename a card (empty, or its default title: back to the default); [[old name]] references on the board follow */
export function renameCard(env: CommandEnv, id: string, v: string) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (!c) return;
    const old = cardTitle(c, b).trim();
    c.title = v.trim() && v.trim() !== cardTitle({ ...c, title: undefined } as Card) ? v.trim() : undefined;
    renameTitleRefs(b, old, cardTitle(c, b).trim());
  });
}

/** A Note, Text or Mark written empty goes away; an empty Box is still a box */
const noteKept = (c: Card | undefined, md: string) => !!md.trim() || (c?.kind === "note" && c.look === "box");
/**
 * Write a Note's Markdown, and the layout its editor changed (table widths, row heights, code wrap; null = all automatic again,
 * left out = unchanged). Written empty it goes away (noteKept), in the same step; a new one written empty goes as if it never
 * was (env.fresh)
 */
export function writeNote(env: CommandEnv, id: string, md: string, layout?: NoteLayout | null) {
  const write = (b: Board) => {
    const c = findCard(b, id)?.card;
    if (c?.kind !== "note") return;
    if (!noteKept(c, md)) return removeCards(b, [id]);
    c.md = md;
    if (layout !== undefined) (c as NoteCard).mdLayout = layout ?? undefined;
  };
  if (env.fresh.is(id)) env.fresh.settle(id, noteKept(findCard(env.board(), id)?.card, md), write);
  else env.edit(write);
}

/**
 * The first edit of a new card or question ended without anything written through writeNote, writeFreeCode or writeQuestion
 * (the editor closed unchanged): it stays when it has content after all (a Box, text put in another way), else it goes
 */
export function settleUnwritten(env: CommandEnv, id: string) {
  if (!env.fresh.is(id)) return;
  const b = env.board();
  const c = findCard(b, id)?.card,
    q = b.stickers.find((s) => s.id === id)?.q;
  const empty = q
    ? !q.md.trim()
    : !c || (c.kind === "note" ? !c.md.trim() : isCode(c) ? !c.segments[0]?.text.join("").trim() : false);
  env.fresh.settle(id, !empty);
}

/** Can these cards make a Compare: exactly two code cards */
export function compareCheck(cs: Card[]): { ok: true } | { ok: false; why: string } {
  if (cs.length !== 2 || !cs.every((c) => c.kind === "code"))
    return { ok: false, why: "Select exactly two code cards" };
  return { ok: true };
}
/** Compare: two code cards side by side in one card, left to right as they are on the board, where the left one was */
export function compare(env: CommandEnv, ids: [string, string]): string | null {
  const b0 = env.board();
  const [p, q] = [...ids].sort((a, c) => b0.place[a].x - b0.place[c].x);
  const id = uid("k");
  const ok = env.edit((b) => {
    const pa = b.place[p],
      pc = b.place[q];
    const section = pa.section ?? pc.section;
    makeCompare(b, id, [p, q], {
      x: pa.x,
      y: pa.y,
      w: Math.min(1280, Math.max(760, pa.w + pc.w)),
      ...(section ? { section } : {}),
    });
  });
  return ok ? id : null;
}
/**
 * Separate a Compare: the left column where the Compare was, the right one beside it, both tilted as it was; arrows and stickers on
 * the Compare move to the left column. The two columns' ids
 */
export function separate(env: CommandEnv, id: string): string[] | null {
  const k = findCard(env.board(), id)?.card;
  if (k?.kind !== "compare") return null;
  const ids = [...k.cols];
  env.edit((b) => {
    const kp = b.place[id];
    const [a, c] = ids.map((i) => b.cards.find((x) => x.id === i)!);
    const wa = defaultWidth(a),
      wc = defaultWidth(c);
    b.place[a.id] = { x: kp.x, y: kp.y, w: wa, section: kp.section };
    b.place[c.id] = { x: kp.x + wa + 40, y: kp.y, w: wc, section: kp.section };
    const tilt = b.cards.find((x) => x.id === id)?.tilt;
    a.tilt = c.tilt = tilt;
    replaceCards(b, [id], () => ({ card: a.id }));
  });
  return ids;
}

/** Can these cards be merged: two or more code cards (class cards too: merged they show their code) */
export function mergeCheck(cs: Card[]): { ok: true } | { ok: false; why: string } {
  if (cs.length < 2) return { ok: false, why: "Select two or more code cards" };
  if (!cs.every((c) => c.kind === "code"))
    return { ok: false, why: "Only code cards can be merged (not Note, Image, Web or Compare cards)" };
  return { ok: true };
}
/**
 * Merge code cards into one (mergeCodeCards): target = the card they were dropped on (its title, description and file order win).
 * Cards also on other boards become copies here first, so the other boards keep theirs. linked = how many were copied
 */
export function mergeCards(
  env: CommandEnv,
  ids: string[],
  target: string,
): { id: string; segments: Segment[]; linked: number } | null {
  const linked = ids.filter((id) => sharedOn(env, id) > 1).length;
  let r: ReturnType<typeof mergeCodeCards> = null;
  const ok = env.edit((b) => {
    r = mergeCodeCards(b, ids, target, { unlink: (id) => sharedOn(env, id) > 1 });
  });
  const m = r as ReturnType<typeof mergeCodeCards>;
  return ok && m ? { ...m, linked } : null;
}
/**
 * Split a card: back into the cards it was merged from (where they were, arrows back on each), or else one card per segment.
 * A card that is a Compare's column is not split (the Compare must be separated first)
 */
export function unmerge(env: CommandEnv, id: string): { made: string[]; segments: Segment[] } | null {
  const b0 = env.board();
  const c = findCard(b0, id)?.card;
  if (!isCode(c) || (!c.mergedFrom && c.segments.length < 2)) return null;
  if (!b0.place[id]) {
    env.toast("Separate the Compare first");
    return null;
  }
  let r: ReturnType<typeof unmergeCard> = null;
  const ok = env.edit((b) => {
    r = unmergeCard(b, id);
  });
  return ok ? (r as ReturnType<typeof unmergeCard>) : null;
}

/** Unlink a shared card: this board gets its own copy (a new id); the other boards and the card library keep the shared card */
export function unlink(env: CommandEnv, id: string): string | null {
  let to = "";
  return env.edit((b) => {
    to = unlinkCard(b, id);
  })
    ? to
    : null;
}

/**
 * A new Section around these cards and Sections, in the frame `rect`. Its parent: `parent` when a frame was drawn, else the
 * Section all the cards were in, if they were in one. A Section is never put inside itself or its descendants
 */
export function newSection(
  env: CommandEnv,
  o: { cards: string[]; sections: string[]; rect: Rect; drawn?: boolean; parent?: string },
): string {
  const id = uid("g");
  env.edit((b) => {
    const homes = [...new Set(o.cards.map((i) => b.place[i]?.section))];
    const parent = o.drawn ? o.parent : homes.length === 1 ? homes[0] : undefined;
    const r = o.rect;
    b.sections.push({ id, title: "Untitled Section", x: r.x, y: r.y, w: r.w, h: r.h, parent });
    for (const i of o.cards) if (b.place[i]) b.place[i].section = id;
    for (const q of o.sections) {
      let ok = true;
      for (
        let a: Section | undefined = b.sections.find((s) => s.id === id);
        a;
        a = b.sections.find((s) => s.id === a!.parent)
      )
        if (a.id === q) ok = false;
      const s = b.sections.find((x) => x.id === q);
      if (ok && s) s.parent = id;
    }
  });
  return id;
}

/**
 * Put new cards on the board in one step. place = where each goes (the shell's layout, in order: it may look at the cards placed
 * before it in `b`); section = the Section they go in, otherwise settle(b, id) files each where it landed. also = more of the same
 * step (one undo)
 */
export function addCards(
  env: CommandEnv,
  cards: Card[],
  o: {
    place: (c: Card, b: Board) => Place;
    section?: string;
    settle?: (b: Board, id: string) => void;
    also?: (b: Board) => void;
  },
): boolean {
  return env.edit((b) => {
    for (const c of cards) {
      placeCards(b, [{ card: c, place: o.place(c, b) }], {
        copy: false,
        at: (q) => (o.section ? { ...q, section: o.section } : q),
      });
      if (!o.section) o.settle?.(b, c.id);
    }
    o.also?.(b);
  });
}

/**
 * Split a code card's one segment at its top-level functions (parts, in order): merge = one card with a segment per function, else
 * one card per function stacked down from where it was (at = its frame on screen: x, y, width). Arrows, sidenotes and
 * stickers on its lines go to the part with that line; the rest to the (first) card
 */
export function splitSegment(
  env: CommandEnv,
  id: string,
  parts: Segment[],
  o: { merge: true } | { merge: false; at: Rect },
) {
  const c = findCard(env.board(), id)?.card;
  if (!isCode(c) || c.segments.length !== 1) return;
  const s = c.segments[0];
  const partOf = (line?: number) =>
    Math.max(
      0,
      parts.findIndex((p) => line !== undefined && line >= p.start && line <= p.end),
    );
  if (o.merge) {
    env.edit((b) => {
      const k = findCard(b, id)?.card;
      if (!isCode(k)) return;
      retargetCards(b, [id], (at) => ({
        card: id,
        seg: at.seg === s.id && at.line ? parts[partOf(at.line)].id : undefined,
      }));
      k.segments = parts;
    });
    return;
  }
  const r = o.at;
  const section = env.board().place[id]?.section;
  const ids = parts.map(() => uid("c"));
  env.edit((b) => {
    retargetCards(b, [id], (at) => {
      const i = partOf(at.seg === s.id ? at.line : undefined);
      return { card: ids[i], seg: at.seg === s.id && at.line ? parts[i].id : undefined };
    });
    removeCards(b, [id]);
    let y = r.y;
    parts.forEach((p, i) => {
      const k: CodeCard = { id: ids[i], kind: "code", segments: [p] };
      b.cards.push(k);
      b.place[k.id] = { x: r.x, y, w: r.w, section };
      y += estSize(k, { w: r.w }).h + GAP;
    });
  });
}
