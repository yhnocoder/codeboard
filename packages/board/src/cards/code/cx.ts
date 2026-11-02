// What the parts of a code card's body share: the card, its rows (code lines, hidden gaps, file and function bars) and the
// element the code lines are in
import type { CodeCard, Row, Segment } from "@codeboard/core";

export type CodeCx = {
  card: () => CodeCard;
  rows: () => Row[];
  segById: (id: string) => Segment | undefined;
  /** The .src element (the code lines, one per row, data-r = the row) */
  src: () => HTMLDivElement;
};
export type LineRow = Extract<Row, { t: "line" }>;

/** The row element (a direct child of .src) node n is in */
export function rowEl(cx: CodeCx, n: Node): HTMLElement | null {
  const src = cx.src();
  let e: Node | null = n;
  while (e && e !== src) {
    if (e instanceof HTMLElement && e.dataset.r !== undefined && e.parentElement === src) return e;
    e = e.parentNode;
  }
  return null;
}
/** The row a row element shows */
export const rowOf = (cx: CodeCx, el: HTMLElement | null): Row | undefined =>
  el ? cx.rows()[+el.dataset.r!] : undefined;
