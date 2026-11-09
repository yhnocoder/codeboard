// The app's edits, as @codeboard/core's commands over a CommandEnv on the bridge's history: new Notes / Texts / Free code, their
// text, delete, duplicate, copy / paste within the board, arrows, Sections. The shell never changes a board collection itself;
// every edit here is one undo step through core (packages/board/src/actions are the reference behaviour).
import {
  cardCopies,
  cardTitle,
  DEFAULT_SETTINGS,
  estSize,
  uid,
  type Board,
  type Card,
  type CardCopy,
  bounds,
  findFree,
  type IconRef,
  NEW_CARD_W,
  type Sidenote,
  type End,
  homeFor,
  type Link,
  type NoteLook,
  type Rect,
  sectionFit,
  sectionFrames,
  type Segment,
} from "@codeboard/core";
import type { createHistory } from "@codeboard/core/history";
import {
  addCards,
  addLink,
  addSidenotes,
  addSticker,
  deleteItems,
  deleteSidenote,
  duplicateCards,
  insertBoard,
  newBlankCode,
  newSection,
  newWriting,
  pasteCards,
  renameCard,
  renameSection,
  setSectionFolded,
  settleUnwritten,
  turnIntoBoard,
  writeFreeCode,
  writeNote,
  writeSidenote,
  type CommandEnv,
} from "@codeboard/core/commands";
import { dropMadeBoard, restoreMadeBoard, type Storage, storeNewBoard } from "@codeboard/host/storage";

export type History = ReturnType<typeof createHistory>;

/** The card's rectangle, by its place and estimated height (the app's measured one when it has it) */
export type Rects = Record<string, { x: number; y: number; w: number; h: number }>;

/** Every placed card's rectangle by its estimated size (the Section frames as drawn follow from them) */
const estRects = (b: Board) =>
  new Map<string, Rect>(
    b.cards
      .filter((c) => b.place[c.id])
      .map((c) => [c.id, { x: b.place[c.id].x, y: b.place[c.id].y, ...estSize(c, b.place[c.id]) }]),
  );

/** A card just placed goes into the Section it lies in (the board's settleHome: core's homeFor over the Section frames) */
const settle = (b: Board, id: string) => {
  const p = b.place[id];
  const c = b.cards.find((k) => k.id === id);
  if (!p || !c) return;
  const s = homeFor(b.sections, sectionFrames(b, estRects(b)), { x: p.x, y: p.y, ...estSize(c, p) })?.id;
  if (s) p.section = s;
  else delete p.section;
};

export type Env = CommandEnv & {
  /** Run fn with every edit it makes folded into one undo step under `key` (core's merge: the live writes of one edit) */
  merging<T>(key: string, fn: () => T): T;
};

export function makeEnv(
  history: History,
  board: () => Board,
  o: {
    toast: (text: string) => void;
    choose: (title: string, options: string[], text?: string) => Promise<number | null>;
    /** The folder's Storage: what the host answers Turn into Board with (newBoard, dropBoard, restoreBoard) */
    storage?: Storage;
    /** A board an undo dropped: whoever has it open lets go of it (the host closes its panel) */
    dropped?: (id: string) => void;
  },
): Env {
  // the few requests the app's commands make, answered with the host's own storage helpers (handlers.ts uses the same)
  const ask = async (type: string, m: Record<string, unknown>): Promise<unknown> => {
    const s = o.storage;
    if (!s) throw new Error("No host in the app");
    const here = board().id;
    switch (type) {
      case "newBoard":
        return storeNewBoard(s, here, m.board);
      case "dropBoard": {
        const gone = await dropMadeBoard(s, here, m.id as string, m.made);
        if (gone) o.dropped?.(m.id as string);
        return gone;
      }
      case "restoreBoard":
        return restoreMadeBoard(s, here, m.id as string);
      default:
        throw new Error(`${type}: not in the app`);
    }
  };
  let merge: string | undefined;
  return {
    board,
    edit: (fn, opts) => history.mutate(fn, { ...opts, merge: opts?.merge ?? merge }),
    merging(key, fn) {
      const was = merge;
      merge = key;
      try {
        return fn();
      } finally {
        merge = was;
      }
    },
    fresh: { add: history.createFresh, is: history.isFresh, settle: history.settleFresh },
    ask: (type, body) => ask(type, body as Record<string, unknown>) as never,
    choose: (q) => o.choose(q.title, q.options, q.text),
    toast: o.toast,
    settings: () => DEFAULT_SETTINGS,
    boardsOf: () => [],
  };
}

/** What ⌘C keeps: the cards, their arrows and where they were (pasted at an offset each time) */
export type Clip = { board: string; items: CardCopy[]; links: Link[]; n: number };

export function commands(env: Env, storage: () => Storage) {
  let clip: Clip | null = null;
  return {
    /** A new Note / Text / Box / Mark / Free Text at (x, y); empty ones are fresh (gone again if nothing is written). Its id */
    newWriting(look: NoteLook, x: number, y: number, text = ""): string {
      return newWriting(env, look, text, { at: () => ({ x, y }), settle });
    },
    /** A new, empty Free code card (fresh) */
    newCode(x: number, y: number): string {
      const id = uid("c");
      const seg: Segment = {
        id: uid("s"),
        src: { kind: "free" },
        path: "",
        lang: "python",
        start: 1,
        end: 1,
        text: [""],
        version: { kind: "none" },
      };
      newBlankCode(env, id, seg, { x, y, w: 381 }, settle);
      return id;
    },
    /** The text of an edit, written while it goes on and when it ends: one undo step for the whole edit */
    writeNote: (id: string, md: string) => env.merging(`edit:${id}`, () => writeNote(env, id, md)),
    writeCode: (id: string, text: string) => env.merging(`edit:${id}`, () => void writeFreeCode(env, id, text)),
    /** An edit ended with nothing written: a fresh card goes */
    settleUnwritten: (id: string) => settleUnwritten(env, id),
    rename: (id: string, title: string) => renameCard(env, id, title),
    delete: (cards: string[], links: string[], sections: string[]) => deleteItems(env, { cards, links, sections }),
    duplicate: (ids: string[]) => duplicateCards(env, ids)?.made ?? [],
    copy(ids: string[]) {
      const b = env.board();
      const have = new Set(ids.filter((id) => b.place[id]));
      if (!have.size) return 0;
      clip = {
        board: b.id,
        items: structuredClone(cardCopies(b, have)),
        links: structuredClone(b.links.filter((l) => have.has(l.from.card) && have.has(l.to.card))),
        n: 0,
      };
      return have.size;
    },
    /** Paste what ⌘C took, as copies 36px further each time (the board's pasteCopied); the new ids */
    paste(): string[] {
      if (!clip || clip.board !== env.board().id) return [];
      const k = ++clip.n;
      // as the board pastes: a step down and right of the originals, then the nearest free spot (core's findFree)
      const tops = clip.items.filter((x) => x.place);
      const box = bounds(
        tops.map((x) => ({ x: x.place!.x, y: x.place!.y, w: x.place!.w, h: (x.place!.h ?? 300) + 40 })),
      );
      if (!box) return [];
      const free = findFree({ ...box, x: box.x + 36 * k, y: box.y + 36 * k }, Object.values(estRects(env.board())));
      const r = pasteCards(env, structuredClone(clip.items), structuredClone(clip.links), {
        copy: true,
        dx: Math.round(free.x - box.x),
        dy: Math.round(free.y - box.y),
        settle,
      });
      return r?.pairs.map(([id]) => id) ?? [];
    },
    addLink: (from: End, to: End) => addLink(env, from, to),
    /** A Section around these cards (their rectangles as drawn), the board's Fit Content margins; its id */
    newSection(ids: string[], rects: Rects): string | null {
      const rect = sectionFit(ids.map((id) => rects[id]).filter(Boolean));
      return rect ? newSection(env, { cards: ids, sections: [], rect }) : null;
    },
    renameSection: (id: string, title: string) => renameSection(env, id, title),
    /** An image saved to assets/ (by content) as an Image card at (x, y), `w` wide (the shell knows the pixel size); its id */
    async newImage(name: string, dataUrl: string, w: number, x: number, y: number): Promise<string> {
      const file = await storage().saveAsset(name, dataUrl);
      const id = uid("i");
      addCards(env, [{ id, kind: "image", src: file }], {
        place: () => ({ x, y, w: Math.max(24, Math.min(NEW_CARD_W, Math.round(w))) }),
        settle,
      });
      return id;
    },
    /** Turn into Board: the cards (rects as drawn) become a new board named `name`, a sub-board frame in their place; the frame's id */
    turnIntoBoard: (ids: string[], name: string, rects: Rects) =>
      turnIntoBoard(
        env,
        ids,
        name,
        (id) => rects[id],
        (c, p) => {
          // the heights drawn here stand in for the VS Code board's measured ones (heightToKeep)
          const h = p.h ? undefined : Math.round(rects[c.id]?.h ?? 0);
          return h && Math.abs(h - estSize(c, p).h) > 2 ? h : undefined;
        },
      ),
    /** A new, empty board as a sub-board card at (x, y); the card's id */
    async newSubboard(name: string, x: number, y: number): Promise<string | null> {
      const s = storage();
      const child = await s.create(name, s.groupOf(env.board().id));
      const metas = await s.list();
      const r = insertBoard(env, child.id, { x, y }, { subs: (id) => metas.find((m) => m.id === id)?.subs, settle });
      return r === "cycle" ? null : r;
    },
    /** A Section folded to its title bar, or opened again (open = its frame as drawn, kept while folded) */
    foldSection(id: string, shut: boolean, open: Rects[string]) {
      const s = env.board().sections.find((k) => k.id === id);
      if (s) setSectionFolded(env, id, shut, { was: !!s.collapsed, open });
    },
    /** A sticker on the canvas at (x, y); a "?" one is a question (q) */
    addSticker: (icon: IconRef, x: number, y: number) => addSticker(env, icon, { kind: "canvas", x, y }, {}),
    deleteStickers: (ids: string[]) => deleteItems(env, { stickers: ids }),
    /** A Text sidenote on a card (on these lines of a segment, or the whole card); its id */
    addSidenote: (card: string, md: string, seg?: string, lines?: [number, number]) =>
      addSidenotes(env, [{ kind: "text", at: seg ? { card, seg, lines } : { card }, md } as Omit<Sidenote, "id">])[0],
    writeSidenote: (id: string, md: string) => writeSidenote(env, id, md),
    deleteSidenote: (id: string) => deleteSidenote(env, id),
    /** Titles on the board, for [[refs]] in Notes */
    titles(): { id: string; title: string }[] {
      const b = env.board();
      return b.cards.filter((c) => b.place[c.id]).map((c) => ({ id: c.id, title: cardTitle(c, b) }));
    },
    /** The card's Markdown / code to edit, or null */
    textOf(id: string): { kind: "note" | "code"; text: string; lang?: string; look?: string } | null {
      const c: Card | undefined = env.board().cards.find((k) => k.id === id);
      if (!c) return null;
      if (c.kind === "note") return { kind: "note", text: c.md, look: c.look };
      if (c.kind === "code" && c.segments[0]?.src.kind === "free")
        return { kind: "code", text: c.segments[0].text.join("\n"), lang: c.segments[0].lang };
      return null;
    },
  };
}
