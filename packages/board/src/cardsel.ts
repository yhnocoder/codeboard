/** A CSS attribute selector for a value that is, or carries, an id (escaped: a pasted board can carry any id) */
export const attrSel = (name: string, value: string) => `[${name}="${CSS.escape(value)}"]`;
/** The CSS selector of a card's element on the board */
export const cardSel = (id: string) => `.card${attrSel("data-id", id)}`;
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
