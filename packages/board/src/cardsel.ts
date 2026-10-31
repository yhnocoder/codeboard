/** The CSS selector of a card's element on the board (ids are escaped: a pasted board can carry any id) */
export const cardSel = (id: string) => `.card[data-id="${CSS.escape(id)}"]`;
