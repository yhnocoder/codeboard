// What ⌘C last put on the clipboard as text, so that ⌘V of the same text on this board lands next to where it came from
import { cardRows, type CodeCard } from "@codeboard/core";
import { state, cardById, rectOf } from "../state/store";

/** 最近一次 ⌘C 复制的是哪张卡的哪段字：⌘V 粘回来时放在那张卡旁边（错开一点，允许重叠），不去找空地 */
let lastCopy: { card: string; text: string; n: number } | null = null;
export function pasteNear(text: string): { x: number; y: number } | null {
  if (!lastCopy || lastCopy.text.trim() !== text.trim()) return null;
  const h = cardById(lastCopy.card)?.host;
  if (!h || !state.board.place[h.id]) return null;
  const r = rectOf(h);
  const k = ++lastCopy.n;
  return { x: r.x + 36 * k, y: r.y + 36 * k };
}
export const remember = (card: string, text: string) => {
  lastCopy = { card, text, n: 0 };
};
/** 代码卡上看得见的行（复制用） */
export function cardText(c: CodeCard): string[] {
  const lines: string[] = [];
  for (const r of cardRows(c, { views: state.views }))
    if (r.t === "line") {
      const s = c.segments.find((q) => q.id === r.seg)!;
      lines.push(s.text[r.line - s.start] ?? "");
    }
  return lines;
}
