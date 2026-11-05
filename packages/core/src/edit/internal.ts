// Helpers the edit modules share, not part of core's API
import { cornerAt, findCard, type Board, type StickerAt } from "../model";

/** 卡右上角、绑在卡上的贴纸位置（Compare 的栏 → 那张 Compare） */
export function cornerOf(b: Board, card: string): StickerAt {
  const host = findCard(b, card)?.host.id ?? card;
  const w = b.place[host]?.w ?? b.shelf?.find((e) => e.place[host])?.place[host].w ?? 320;
  return { kind: "canvas", ...cornerAt(w), on: { card: host } };
}

/** Shelf entries left with nothing in them (their cards deleted meanwhile) go; an empty Shelf is no field */
export function tidyShelf(b: Board): void {
  if (!b.shelf) return;
  b.shelf = b.shelf.filter((e) => Object.keys(e.place).length || e.sections.length);
  if (!b.shelf.length) delete b.shelf;
}
