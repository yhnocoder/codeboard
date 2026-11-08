// Turn into Board's storage side, shared by the extension's handlers and the macOS app: the new board stored from the shell's
// copy (schema-checked), dropped again by an undo only while it is as made and no other board holds it, restored by a redo
import { checkBoard } from "@codeboard/core";
import type { Storage } from "./boards";
import { SAFE_ID } from "./names";

/** newBoard: the board cut from `parent` saved in its group, the parent's shared cards still shared */
export async function storeNewBoard(store: Storage, parent: string, board: unknown): Promise<true> {
  const b = checkBoard(board);
  if (!SAFE_ID.test(b.id) || (await store.load(b.id))) throw new Error("Bad board id.");
  const refs = [...store.refsOf(parent)].filter((id) => b.cards.some((c) => c.id === id));
  await store.save(b, { group: store.groupOf(parent) ?? null, refs });
  return true;
}

/** dropBoard: gone (to .trash) when unchanged since it was made and no board but `parent` holds it; whether it went */
export async function dropMadeBoard(store: Storage, parent: string, id: string, made: unknown): Promise<boolean> {
  if ((await store.list()).some((x) => x.id !== parent && x.subs?.includes(id))) return false;
  // checked the same way it was when stored (newBoard saved the checked copy)
  return store.dropIfUnchanged(id, checkBoard(made));
}

/** restoreBoard: back from .trash into the parent's group */
export function restoreMadeBoard(store: Storage, parent: string, id: string): Promise<boolean> {
  return store.restore(id, store.groupOf(parent));
}

