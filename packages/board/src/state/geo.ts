// 卡片里每一行的位置（实测）
import { rowIndexOf, type Row } from "@codeboard/core";
import { rectOf, cardById, onBoard } from "./store";
import { boardStore } from "./root";

export type CardGeo = {
  rows: Row[];
  ys: number[]; // 每行顶部（相对卡片顶部，未减滚动）
  hs: number[];
  top: number; // 代码区可见范围（相对卡片顶部）
  bottom: number;
  scroll: number;
  head: number; // 标题栏高度
  colX?: number; // Compare 卡里这一栏的左边（相对 Compare 卡）
  colW?: number;
};
export const [geo, setGeo] = boardStore<Record<string, CardGeo>>(() => ({}), onBoard);
/** 没量过卡头的卡（不是代码卡）按这个卡头高度算 */
export const HEAD_H = 34;

/** 某一行在世界坐标里的 y；行被滚出代码区时贴在边上（clamped = true） */
export function lineY(
  cardId: string,
  seg: string | undefined,
  line: number | undefined,
): { y: number; clamped: boolean; row?: number } | null {
  const f = cardById(cardId);
  if (!f) return null;
  const r = rectOf(f.host);
  const g = geo[cardId];
  if (!g || seg === undefined || line === undefined) return { y: r.y + (g?.head ?? HEAD_H) / 2, clamped: false };
  const i = rowIndexOf(g.rows, seg, line);
  if (i < 0) return { y: r.y + g.head / 2, clamped: false };
  let y = g.ys[i] + g.hs[i] / 2 - g.scroll;
  let clamped = false;
  if (y < g.top) {
    y = g.top;
    clamped = true;
  }
  if (y > g.bottom) {
    y = g.bottom;
    clamped = true;
  }
  return { y: r.y + y, clamped, row: i };
}
