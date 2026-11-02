// Helpers the edit modules share, not part of core's API
import { cornerAt, findCard, type Board, type StickerAt } from "../model";

/** 卡右上角、绑在卡上的贴纸位置（Compare 的栏 → 那张 Compare） */
export function cornerOf(b: Board, card: string): StickerAt {
  const host = findCard(b, card)?.host.id ?? card;
  return { kind: "canvas", ...cornerAt(b.place[host]?.w ?? 320), on: { card: host } };
}
