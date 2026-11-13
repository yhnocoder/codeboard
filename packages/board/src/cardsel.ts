import type { Card } from "@codeboard/core";

/** A CSS attribute selector for a value that is, or carries, an id (escaped: a pasted board can carry any id) */
export const attrSel = (name: string, value: string) => `[${name}="${CSS.escape(value)}"]`;
/** The CSS selector of a card's element on the board */
export const cardSel = (id: string) => `.card${attrSel("data-id", id)}`;
/** The classes a card's element gets from what it is (its kind, a Note's look), beside .card */
export function cardKindClass(k: Card): string {
  if (k.kind === "note")
    return k.msg ? "note msg" : k.look === "note" ? "note" : k.look === "text" ? "text" : `text ${k.look}`;
  return k.kind === "compare" ? "cmp" : k.kind === "code" ? "ccard" : k.kind;
}
/** The classes a card's element gets from what is happening to it (selection, drags, culling, zoom level, walkthrough,
 *  a ping), not from what it is: a copy of the element (an export, a card's preview) takes them off */
export const CARD_STATE_CLASSES = [
  "sel",
  "solo",
  "lift",
  "landing",
  "carry",
  "dim",
  "editing",
  "off",
  "far",
  "bars",
  "skel",
  "skel-in",
  "merge-hot",
  "merge-arm",
  "drop-hot",
  "drop-cand",
  "img-drop",
  "aim",
  "bind-hot",
  "bind-anchor",
  "ping",
];
