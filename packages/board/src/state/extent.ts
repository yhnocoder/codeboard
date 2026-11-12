// What a fit frames besides cards and sections: things drawn beside the cards whose size only the DOM knows
// (a link's label box, the grey alternatives column next to a call's target). Their components register here with the
// last size their ResizeObserver reported, so a fit reads no layout. The last non-zero size is kept.
import type { Rect } from "@codeboard/core";
import { state } from "./store";
import { boardMap } from "./root";

export type Extra = {
  /** label = the box on the line; alts = the column beside the target card */
  kind: "label" | "alts";
  link: string;
  /** World rect, or null while it has no position (its line is not drawn) */
  rect: () => Rect | null;
};

const extras = new Set<Extra>();
// 换白板时留下新白板上还有的线的（画着它们的组件不重建，不会再报一次）
const sizes = boardMap<string, { w: number; h: number }>((key) => {
  const link = key.slice(key.indexOf(":") + 1);
  return state.board.links.some((l) => l.id === link);
});

export function addExtra(e: Extra) {
  extras.add(e);
  return () => {
    extras.delete(e);
  };
}
export const extraList = () => extras;

/** Remember a measured size under key (`label:<link>`, `alts:<link>`); a 0 × 0 report (hidden) keeps the last one */
export function keepSize(key: string, s: { w: number; h: number }) {
  if (s.w > 0 && s.h > 0) sizes.set(key, s);
}
export const keptSize = (key: string) => sizes.get(key);
