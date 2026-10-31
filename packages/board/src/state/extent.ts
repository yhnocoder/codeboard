// What a fit frames besides cards and sections: things drawn beside the cards whose size only the DOM knows
// (a link's label box, the grey alternatives column next to a call's target). Their components register here with the
// last size their ResizeObserver reported, so a fit reads no layout. The last non-zero size is kept: zoomed out to the
// map level these are hidden (0 × 0 or not rendered), and a fit from there lands on a zoom where they show again.
import type { Rect } from "@codeboard/core";

export type Extra = {
  /** label = the box on the line; alts = the column beside the target card */
  kind: "label" | "alts";
  link: string;
  /** World rect, or null while it has no position (its line is not drawn) */
  rect: () => Rect | null;
};

const extras = new Set<Extra>();
const sizes = new Map<string, { w: number; h: number }>();

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
