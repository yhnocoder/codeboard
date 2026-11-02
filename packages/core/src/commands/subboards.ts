// Sub-boards: Turn into Board, and a sub-board frame whose board was deleted
import { uid, type Board, type Card, type Place } from "../model";
import type { Rect } from "../layout";
import { removeCards } from "../edit";
import { extractBoard } from "../subboard";
import type { CommandEnv } from "./env";

/**
 * Turn into Board: these cards (and the Sections wholly among them) become a new board named `name`, and a sub-board frame takes
 * their place here; arrows from outside go to the frame. rects = the cards' measured frames; keep(c, p) = a height to keep on the
 * new board (Place.mh), so its map draws at the real size from the start. The new board is made by the host first and this board
 * changes only once it is; undo drops it again (when it was not changed since), redo brings it back. The frame's id
 */
export async function turnIntoBoard(
  env: CommandEnv,
  ids: string[],
  name: string,
  rects: (id: string) => Rect,
  keep: (c: Card, p: Place) => number | undefined,
): Promise<string | null> {
  const id = uid("b"),
    frame = uid("c");
  // the new board is cut from a copy first and given to the host to store; this board changes once it is (same ids, same result)
  const r = extractBoard(structuredClone(env.board()), ids, rects, { id, name, frame });
  if (!r) return null;
  for (const c of r.child.cards) {
    const p = r.child.place[c.id],
      mh = p && keep(c, p);
    if (mh) p.mh = mh;
  }
  try {
    await env.ask("newBoard", { board: r.child });
  } catch (e) {
    env.toast(`Couldn't create the board: ${(e as Error).message}`);
    return null;
  }
  let dropped = false;
  const ok = env.edit(
    (b) => {
      extractBoard(b, ids, rects, { id, name, frame });
    },
    {
      fx: {
        undo: () => {
          void env.ask("dropBoard", { id, made: r.child }).then(
            (d) => {
              dropped = d;
            },
            () => {},
          );
        },
        redo: () => {
          if (!dropped) return;
          void env
            .ask("restoreBoard", { id })
            .then((back) => (back ? true : env.ask("newBoard", { board: r.child })))
            .then(
              () => {
                dropped = false;
              },
              (e: Error) => env.toast(`Couldn't create the board: ${e.message}`),
            );
        },
      },
    },
  );
  return ok ? frame : null;
}

/** The frames of a sub-board that was deleted come off this board */
export function removeBoardFrames(env: CommandEnv, board: string) {
  env.edit((b: Board) =>
    removeCards(
      b,
      b.cards.filter((c) => c.kind === "board" && c.board === board).map((c) => c.id),
    ),
  );
}
