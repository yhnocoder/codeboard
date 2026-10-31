// What every change to the board also does, in the same step (no Solid; `raw` reads past a draft's proxy):
// - the same card placed several times (`same`): the copy that changed is copied to the others (core syncTwins)
// - a Note's text changed: arrow ends on one of its blocks follow that block (md/blocks.ts → core rebaseBlocks)
// Each keeps what it saw last; after undo or a board switch `reset` and run again, so it starts from that board
import { stampBorn, syncTwins, type Board } from "@codeboard/core";
import { followBlocks } from "../md/blocks";

export type Raw = <T>(x: T) => T;

export function upkeeper(raw: Raw) {
  const twinSeen = new Map<string, string>();
  const blockSeen = new Map<string, string>();
  return {
    run(b: Board) {
      if (raw(b).cards.some((c) => c.same)) syncTwins(b, twinSeen, raw);
      else twinSeen.clear();
      followBlocks(b, blockSeen, raw);
    },
    reset() { twinSeen.clear(); blockSeen.clear(); },
  };
}

/**
 * New cards get their creation order (core stampBorn). Checked on the raw object first: moves, undo and other changes that add
 * no card skip it without reading every card through the draft. When some are missing they are numbered on a plain copy and
 * `born` is replaced once: a batch of cards from the host is one notification, not one per card (30 ms at 241 cards)
 */
export function stamp(b: Board, raw: Raw) {
  const r = raw(b), born = r.born;
  if (born && r.cards.every((c) => born[c.id] !== undefined)) return;
  const tmp = { cards: r.cards, born: { ...born }, seq: r.seq } as Board;
  stampBorn(tmp);
  b.born = tmp.born;
  b.seq = tmp.seq;
}
