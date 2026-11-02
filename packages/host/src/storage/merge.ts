// Three-way merges between this window and the files another window (or git) wrote: a shared card item by item against
// the library's file, and a board file against the one on disk.
import {
  BOARD_VERSION,
  deflate,
  diffBoards,
  inflate,
  mergeById,
  pruneRefs,
  same,
  type Board,
  type BoardFile,
  type BoardPatch,
  type Camera,
  type SharedCard,
  type SharedCardFile,
} from "@codeboard/core";

/**
 * 白板上的一张共享卡（view）按项（卡、每条 Sidenote）合并进卡库里的那份（disk）。base = 这块白板上次读到 / 写下的那份：
 * 和 base 比变了的项是这块白板改的，用它的；没改的项用磁盘上的（另一个窗口可能改过、加过）；base 里有、view 里没有的项是这块白板删的。
 * 没有 base（这块白板第一次存这张卡，比如刚贴过来）：它的项都算它改的，但不删任何项。
 * 返回要写的文件（和磁盘上一样时 null）、这块白板改了的项（mine）、和磁盘上比变了的项（items，发给别的白板）、和 view 比变了的项（back，这块白板自己要换上）。
 * Sidenote 的先后不算（每块白板上可能不一样）
 */
export function merged(
  base: SharedCard | undefined,
  disk: SharedCard | undefined,
  view: SharedCard,
): { file: SharedCardFile | null; mine: string[]; items: string[]; back: string[] } {
  const c = mergeById(base && [base.card], disk ? [disk.card] : [], [view.card]);
  const n = mergeById(base?.sidenotes, disk?.sidenotes ?? [], view.sidenotes);
  const now: SharedCard = { card: c.items[0] ?? view.card, sidenotes: n.items };
  const items = itemsChanged(disk, now);
  const file: SharedCardFile | null =
    items.length || !disk ? structuredClone({ version: BOARD_VERSION, ...now }) : null;
  return {
    file,
    mine: [...c.changed, ...n.changed],
    items: [...new Set([...items, ...itemsChanged(base, now)])],
    back: itemsChanged(view, now),
  };
}

/**
 * 卡库里的一张卡（sc）换进重建的白板：白板上还没写盘的、改了这张卡的项（view 和它上次看到的 base 比变了的）留着，别的项用卡库的。
 * 白板文件里只有共享卡的引用，另一个窗口只挪了卡时，卡库里还是这块白板改之前的内容
 */
export function withPending(base: SharedCard | undefined, view: SharedCard | undefined, sc: SharedCard): SharedCard {
  if (!base || !view) return structuredClone({ card: sc.card, sidenotes: sc.sidenotes });
  const c = mergeById([base.card], [sc.card], [view.card]),
    n = mergeById(base.sidenotes, sc.sidenotes, view.sidenotes);
  return structuredClone({ card: c.items[0] ?? sc.card, sidenotes: n.items });
}

/** 共享卡从 x 到 y 变了的项（卡 id、Sidenote 的 id：改了、加了、删了的）；Sidenote 的先后不算 */
export function itemsChanged(x: SharedCard | undefined, y: SharedCard): string[] {
  const xs = new Map((x?.sidenotes ?? []).map((n) => [n.id, n]));
  const d = same(x?.card, y.card) ? [] : [y.card.id];
  for (const n of y.sidenotes) {
    if (!same(xs.get(n.id), n)) d.push(n.id);
    xs.delete(n.id);
  }
  return [...d, ...xs.keys()];
}

/**
 * A board file merged item by item (mergeFile, done by the caller) put back together into the board it replaces: shared
 * cards from `shared`, references the merge left dangling (that side deleted a card, this side linked to it) pruned as
 * deleting a card would; inflated = what reading the disk file still does to the board (readBoardFile). Returns the board, its shared cards, its file and the patch from the board it replaces
 */
export function rebuild(
  was: Board,
  both: BoardFile,
  cam: Camera,
  shared: (id: string) => SharedCard | undefined,
  inflated?: (b: Board) => void,
): { board: Board; refs: string[]; file: BoardFile; patch: BoardPatch | null } {
  const r = inflate(both, cam, shared);
  inflated?.(r.board);
  // 按项合并不管引用（那边删了卡、这边往它上面连了线）：按删卡的规矩带走悬空的
  pruneRefs(r.board);
  const file = deflate(r.board, new Set(r.refs)).file;
  return { board: r.board, refs: r.refs, file, patch: diffBoards(was, r.board) };
}
