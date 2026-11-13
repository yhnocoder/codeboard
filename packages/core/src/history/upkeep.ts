// What every change to the board also does, in the same step (no Solid; `raw` reads past a draft's proxy):
// - the same card placed several times (`same`): the copy that changed is copied to the others (syncTwins)
// - a Note's text changed: arrow ends on one of its blocks follow that block (followBlocks → rebaseBlocks)
// Each keeps what it saw last; after undo or a board switch `reset` and run again, so it starts from that board
import type { Board } from "../model";
import { rebaseBlocks, stampBorn, syncTwins } from "../edit";

export type Raw = <T>(x: T) => T;
/**
 * A Note's top-level blocks as Markdown, one string each, or null when it can't be split. Core does not parse Markdown: the shell
 * splits it the way its renderer does (the board: @yhnocoder/markdown's mdBlockStarts), so blocks match what is on screen
 */
export type NoteBlocks = (md: string) => string[] | null;

export function upkeeper(raw: Raw, noteBlocks: NoteBlocks) {
  const twinSeen = new Map<string, string>();
  const blockSeen = new Map<string, string>();
  return {
    /** across: the change is a user's edit, whose blocks may have moved from one Note to another (not a sync from the host) */
    run(b: Board, across = false) {
      if (raw(b).cards.some((c) => c.same)) syncTwins(b, twinSeen, raw);
      else twinSeen.clear();
      followBlocks(b, blockSeen, raw, noteBlocks, across);
    },
    reset() {
      twinSeen.clear();
      blockSeen.clear();
    },
  };
}

/**
 * Arrow ends on a block of a Note whose Markdown changed follow that block. seen = each Note's Markdown last time; nothing is kept
 * while no arrow on the board ends on a block (nothing to follow). Notes new this time (Split by Headings made them) and the
 * other Notes a user's edit changed in the same step (blocks moved between Notes) go to rebaseBlocks: a block deleted here that
 * arrived there takes its arrow ends along. Only blocks new in that other Note count as arrived: a "---" or a heading it already
 * had is not where a deleted one went
 */
function followBlocks(b: Board, seen: Map<string, string>, raw: Raw, noteBlocks: NoteBlocks, across: boolean): void {
  const rb = raw(b);
  const on = new Set<string>();
  for (const l of rb.links) {
    if (l.from.block) on.add(l.from.card);
    if (l.to.block) on.add(l.to.card);
  }
  if (!on.size) {
    seen.clear();
    return;
  }
  const first = !seen.size,
    now = new Map<string, string>(),
    fresh: { card: string; blocks: string[] }[] = [],
    changed: [string, string, string][] = [],
    edited: { card: string; blocks: string[] }[] = [];
  for (const c of rb.cards) {
    if (c.kind !== "note") continue;
    now.set(c.id, c.md);
    const was = seen.get(c.id);
    if (was === undefined) {
      if (!first)
        fresh.push({
          card: c.id,
          get blocks() {
            return noteBlocks(c.md) ?? [];
          },
        });
    } else if (was !== c.md) {
      if (on.has(c.id)) changed.push([c.id, was, c.md]);
      const md = c.md;
      if (across)
        edited.push({
          card: c.id,
          get blocks() {
            return arrived(noteBlocks(was) ?? [], noteBlocks(md) ?? []);
          },
        });
    }
  }
  // a block can go to a Note made now or to another Note changed in the same step (blocks moved from one Note to another)
  for (const [id, was, md] of changed)
    rebaseBlocks(b, id, noteBlocks(was), noteBlocks(md), [...fresh, ...edited.filter((e) => e.card !== id)]);
  seen.clear();
  for (const [k, v] of now) seen.set(k, v);
}

/** A Note's blocks now, those it already had blanked out (by position, so the others keep their index) */
function arrived(was: string[], now: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of was) left.set(x, (left.get(x) ?? 0) + 1);
  return now.map((x) => {
    const n = left.get(x) ?? 0;
    if (!n) return x;
    left.set(x, n - 1);
    return "";
  });
}

/**
 * New cards get their creation order (stampBorn). Checked on the raw object first: moves, undo and other changes that add no
 * card skip it without reading every card through the draft. When some are missing they are numbered on a plain copy and `born`
 * is replaced once: a batch of cards from the host is one notification, not one per card (30 ms at 241 cards)
 */
export function stamp(b: Board, raw: Raw) {
  const r = raw(b),
    born = r.born;
  if (born && r.cards.every((c) => born[c.id] !== undefined)) return;
  const tmp = { cards: r.cards, born: { ...born }, seq: r.seq } as Board;
  stampBorn(tmp);
  b.born = tmp.born;
  b.seq = tmp.seq;
}
