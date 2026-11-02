// Sub-boards: Turn into Board, a board inserted as a sub-board, and a sub-board frame whose board was deleted
import { uid, type Board, type BoardCard, type Card, type Place } from "../model";
import type { Rect } from "../layout";
import { removeCards } from "../edit";
import { extractBoard, wouldCycle } from "../subboard";
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

/**
 * Insert Board: the board `child` as a sub-board frame at `at`, filed by settle(b, id) in the Section it landed in. Not this board
 * itself, nor one this board is inside of (subs(id) = a board's sub-boards, as the shell knows them): cycle. The frame's id, or
 * null when the edit failed
 */
export function insertBoard(
  env: CommandEnv,
  child: string,
  at: { x: number; y: number },
  o: { subs: (id: string) => readonly string[] | undefined; settle: (b: Board, id: string) => void },
): string | "cycle" | null {
  const here = env.board().id;
  if (child === here || wouldCycle(o.subs, here, child)) return "cycle";
  const id = uid("c");
  return env.edit((b) => {
    b.cards.push({ id, kind: "board", board: child } satisfies BoardCard);
    b.place[id] = { x: Math.round(at.x), y: Math.round(at.y), w: 560, h: 360 };
    o.settle(b, id);
  })
    ? id
    : null;
}
