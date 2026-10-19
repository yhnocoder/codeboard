// 指针归谁：一处写清楚，interact.ts 的拖动、画布、放贴纸都用这几个选择器。
// 元素自己处理指针（按钮条、浮层、卡上的小把手）就标 data-nodrag，不再各自 stopPropagation

/** 标了 data-nodrag 的元素：卡片拖动、画布框选 / 平移都不从这里开始 */
export const NODRAG = "[data-nodrag]";
/** 卡里能点、能输入的东西：按下去不拖卡。.call / a.lnk 是 core、Markdown 渲染出来的 HTML（library 调用 data-p 当普通文字） */
export const CARD_CONTROL = `${NODRAG}, [contenteditable], input, textarea, select, button:not([data-dragclick]), .call:not([data-p]), a.lnk`;
/** 画布上自己处理指针的东西：按在这些上面不框选、不平移 */
export const OWNS_POINTER = `.card, .slabel, .lhit, .lmid, .vchips, ${NODRAG}`;
/** 浮在画布上的工具条（不是白板内容）：放贴纸时点在这上面不算 */
export const BOARD_CHROME = ".alignbar";
