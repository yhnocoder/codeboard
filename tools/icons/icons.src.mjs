// Source of the UI icons in packages/board/src/ui/icons.tsx (written by gen.mjs).
// Lucide shapes (lucide-static, 24 grid) scaled by 2/3 to 16 and redrawn by hand:
// every horizontal / vertical stroke and every circle / corner tangent sits on a whole coordinate, so a 2 px stroke covers
// exactly two pixel rows; 1 px themes shift the whole stroke layer by (-.5, -.5) in CSS and land on pixel centres.
// Keep features at least 3 apart (centre to centre) so 2 px strokes keep a 1 px gap.
import { poly, rect, circle, line, lucide } from "./shapes.mjs";

// Corner radius of frames and bars (stroke centre line). Half a pixel keeps the whole arc inside the corner pixel at 1x
// (1 px stroke) and gives a 1.5 px outer radius with 2 px strokes; a 1 px radius (Lucide's 1.33 rounded) measured softer
// than the old set at 2x, see check.mjs.
export const R = +(process.env.ICON_R ?? 0.5);

const corners = (a = 2, b = 14, arm = 3, r = R) => [
  poly([[a, a + arm], [a, a, r], [a + arm, a]]), poly([[b - arm, a], [b, a, r], [b, a + arm]]),
  poly([[b, b - arm], [b, b, r], [b - arm, b]]), poly([[a + arm, b], [a, b, r], [a, b - arm]]),
].join("");

/** name: [stroke path, fill path?, Lucide name] */
export const ICONS = {
  plus: ["M8 3v10M3 8h10", "", "plus"],
  minus: ["M3 8h10", "", "minus"],
  fit: [corners(), "", "scan"],
  more: ["", "M2 7h2v2H2zM7 7h2v2H7zM12 7h2v2h-2z", "ellipsis"],
  chev: ["M4 6l4 4 4-4", "", "chevron-down"],
  chevR: ["M6 12l4-4-4-4", "", "chevron-right"],
  left: ["M10 12 6 8l4-4", "", "chevron-left"],
  right: ["M6 12l4-4-4-4", "", "chevron-right"],
  close: ["M12 4 4 12M4 4l8 8", "", "x"],
  play: [poly([[4, 3, R], [13, 8, R], [4, 13, R]], true), "", "play"],
  entry: ["M7 11l3-3-3-3M10 8H2" + poly([[10, 2], [14, 2, R], [14, 14, R], [10, 14]]), "", "log-in"],
  search: [circle(7, 7, 5) + line(10.6, 10.6, 14, 14), "", "search"],
  note: [poly([[10, 2], [14, 6], [14, 14, R], [2, 14, R], [2, 2, R]], true) + poly([[10, 2], [10, 6, R], [14, 6]]), "", "sticky-note"],
  code: ["M10.5 11.5 14 8l-3.5-3.5M5.5 4.5 2 8l3.5 3.5", "", "code"],
  image: [rect(2, 2, 14, 14, R) + circle(6, 6, 1) + "M14 10l-2.3-2.3a1 1 0 0 0-1.4 0L4 14", "", "image"],
  web: [circle(8, 8, 6) + "M8 2a10 10 0 0 0 0 12 10 10 0 0 0 0-12M2 8h12", "", "globe"],
  section: [poly([[2, 3, R], [7, 3], [8.5, 5], [14, 5, R], [14, 13, R], [2, 13, R]], true), "", "folder"],
  link: ["M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71L7.84 3.46M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14", "", "link"],
  text: ["M8 3v10M6 13h4" + poly([[3, 5], [3, 3, R], [13, 3, R], [13, 5]]), "", "type"],
  mark: ["M10.5 2.5l2.5 2.5L7 11H4.5V8.5zM2 14c1.3-.8 2.7-.8 4 0s2.7.8 4 0 2.7-.8 4 0", "", "pen with a squiggle"],
  box: [rect(2, 4, 14, 12, 2), "", "rectangle-horizontal"],
  undo: ["M6 10 2 6l4-4M2 6h7.5a3.5 3.5 0 0 1 0 7H7", "", "undo-2"],
  redo: ["M10 10l4-4-4-4M14 6H6.5a3.5 3.5 0 0 0 0 7H9", "", "redo-2"],
  lock: [rect(2, 7, 14, 14, R) + "M5 7V5a3 3 0 0 1 6 0v2", "", "lock"],
  unlock: [rect(2, 7, 14, 14, R) + "M5 7V5a3 3 0 0 1 5.94-.6", "", "lock-open"],
  loop: ["M14 8a6 6 0 1 1-6-6c1.7 0 3.3.7 4.5 1.8L14 5M14 2v3h-3", "", "rotate-cw"],
  layout: [rect(2, 2, 14, 14, R) + "M6 2v12", "", "panel-left"],
  focus: [circle(8, 8, 2) + corners(), "", "focus"],
  pin: ["M6 2h4a1 1 0 0 1 0 2H6a1 1 0 0 1 0-2zM6 4v3.5L3.5 9.6a1 1 0 0 0-.5.9v.5h10v-.5a1 1 0 0 0-.5-.9L10 7.5V4M8 11v3", "", "pin"],
  eye: ["M1.5 8a6.73 6.73 0 0 1 13 0 6.73 6.73 0 0 1-13 0z" + circle(8, 8, 2), "", "eye"],
  swap: ["M11 2l3 3-3 3M14 5H2M5 14l-3-3 3-3M2 11h12", "", "arrow-right-left"],
  check: ["M13 4 6 11 3 8", "", "check"],
  alignL: ["M2 1v14" + rect(5, 2, 14, 6, R) + rect(5, 10, 11, 14, R), "", "align-start-vertical"],
  alignC: ["M8 1v1M8 6v4M8 14v1" + rect(2, 2, 14, 6, R) + rect(4, 10, 12, 14, R), "", "align-center-vertical"],
  alignR: ["M14 1v14" + rect(2, 2, 11, 6, R) + rect(5, 10, 11, 14, R), "", "align-end-vertical"],
  alignT: ["M1 2h14" + rect(2, 5, 6, 14, R) + rect(10, 5, 14, 11, R), "", "align-start-horizontal"],
  alignB: ["M1 14h14" + rect(2, 2, 6, 11, R) + rect(10, 5, 14, 11, R), "", "align-end-horizontal"],
  distH: ["M2 2v12M14 2v12" + rect(6, 4, 10, 12, R), "", "align-horizontal-space-around"],
  distV: ["M2 2h12M2 14h12" + rect(4, 6, 12, 10, R), "", "align-vertical-space-around"],
  sameW: [rect(2, 2, 14, 6, R) + rect(2, 10, 14, 14, R), "", "stretch-horizontal"],
  external: ["M10 2h4v4M14 2 7 9" + poly([[12, 9], [12, 14, R], [2, 14, R], [2, 4, R], [7, 4]]), "", "external-link"],
  newSection: [rect(2, 3, 14, 13, 2) + "M2 6h12", "", "Section frame with a title bar (multi-select toolbar)"],
  subBoard: [rect(2, 2, 14, 14, 2) + rect(5, 5, 11, 11, 1), "", "board in a board (multi-select toolbar)"],
  tidy: [rect(2, 2, 6, 6, 1) + rect(10, 2, 14, 6, 1) + rect(2, 10, 6, 14, 1) + rect(10, 10, 14, 14, 1), "", "layout-grid"],
  copy: [rect(6, 6, 14, 14, R) + poly([[3, 10], [2, 10, R], [2, 2, R], [10, 2, R], [10, 3]]), "", "copy"],
  // 三张叠着的方块（square-stack 简化成三层，线间距 3）
  boards: [poly([[2, 7], [2, 2, R], [7, 2]]) + poly([[5, 10], [5, 5, R], [10, 5]]) + rect(8, 8, 14, 14, R), "", "square-stack"],
  trash: ["M2 4h12M6 7v4M10 7v4" + poly([[13, 4], [13, 14, R], [3, 14, R], [3, 4]]) + poly([[6, 4], [6, 2, R], [10, 2, R], [10, 4]]), "", "trash-2"],
  dot: ["", "M7 7h2v2H7z", "dot"],
  compact: ["M2 4h12M2 8h12M2 12h12", "", "menu"],
  rich: [rect(2, 2, 6, 6, R) + rect(2, 10, 6, 14, R) + "M9 3h5M9 6h5M9 11h5M9 14h5", "", "layout-list"],
  sticker: [poly([[10, 2], [14, 6], [14, 14, R], [2, 14, R], [2, 2, R]], true) + poly([[10, 2], [10, 6, R], [14, 6]]) + "M6 11c1.2 1 2.8 1 4 0", "M5 7h2v2H5zM9 7h2v2H9z", "sticker"],
  clock: [circle(8, 8, 6) + "M8 5v3l2.5 1.5", "", "clock"],
  arrowR: ["M3 8h10M9 4l4 4-4 4", "", "arrow-right"],
  // New Arrow (bottom toolbar): an arrow leaving a card, a small ring, and bending towards another (not the chain "link",
  // which reads as a URL). The bend is a 5 radius quarter arc with its tangent points on whole coordinates
  arrowLink: [circle(4, 12, 2) + "M4 10V9a5 5 0 0 1 5-5h5M11 1l3 3-3 3", "", "custom: ring with a bent arrow"],
  // 圆圈里一个问号（circle-help），点是填色的小方块
  question: [circle(8, 8, 6) + "M6.5 6.5a1.5 1.5 0 0 1 3 0c0 1-1.5 1.5-1.5 2.5", "M7 11h2v2H7z", "circle-help"],
  // 托盘上一个向上的箭头（share）
  export: ["M8 2v8M5 5l3-3 3 3" + poly([[3, 8], [3, 14, R], [13, 14, R], [13, 8]]), "", "share"],
};

// The Markdown editor's selection toolbar (packages/markdown/src/editor/icons.tsx): the same grid rules, written into the package
// because it imports nothing from the board. code and link are the board's shapes.
export const MD_ICONS = {
  bold: ["M4 8h6a2.5 2.5 0 0 1 0 5H4.5a.5 .5 0 0 1-.5-.5v-9a.5 .5 0 0 1 .5-.5H9a2.5 2.5 0 0 1 0 5", "", "bold"],
  italic: ["M13 3H7M9 13H3M10 3 6 13", "", "italic"],
  strike: ["M11 3H6.5a2.5 2.5 0 0 0-1.77 4.27M9.5 8a2.5 2.5 0 0 1 0 5H4M2 8h12", "", "strikethrough"],
  code: ICONS.code,
  link: ICONS.link,
  highlight: [poly([[14, 8], [11, 11, 1], [7, 7, 1], [11, 3]]) + "M7 8l-4 4v2h5l2-2", "", "highlighter"],
  math: ["M12 5V3.5a.5 .5 0 0 0-.5-.5H4l4 5-4 5h7.5a.5 .5 0 0 0 .5-.5V11", "", "sigma"],
  annot: ICONS.mark,
};

// Sticker built-ins (stickers/glyphs.tsx): white marks on a coloured disc, drawn on the same 16 grid and placed in the
// sticker's 24 box at 3/4 scale (16 grid 0..16 -> 6..18), so at the default 32 px sticker size one grid unit is one pixel.
// Stickers scale with the canvas, so their marks are not pixel-snapped beyond that; stroke stays 2 in the 24 box (themes.css
// changes it per look). fill: filled and stroked (width 1) with the same colour, which rounds the corners like Lucide's strokes.
export const STICKER_BOX = { s: 0.75, o: 6 };
export const STICKERS = {
  star: { fill: lucide("M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"), lucide: "star" },
  question: { d: "M5 5.5a3 3 0 0 1 5.83 1c0 2-2.83 2.5-2.83 4.5M8 14h.01", lucide: "circle-question-mark" },
  exclaim: { d: "M8 2.5v7.5M8 14h.01", lucide: "circle-alert" },
  check: { d: "M13.5 4.5 6 12 2.5 8.5", lucide: "check" },
  flag: { d: lucide("M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"), lucide: "flag" },
  // Lucide's zap before its 2024 rounding: the rounded one fills into a blob at sticker size
  zap: { fill: lucide("M13 2 3 14h9l-1 8 10-12h-9l1-8z"), lucide: "zap" },
  bug: { d: lucide("M12 20v-9M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4zM14.12 3.88 16 2M21 21a4 4 0 0 0-3.81-4M21 5a4 4 0 0 1-3.55 3.97M22 13h-4M3 21a4 4 0 0 1 3.81-4M3 5a4 4 0 0 0 3.55 3.97M6 13H2m6-11 1.88 1.88M9 7.13V6a3 3 0 1 1 6 0v1.13"), lucide: "bug" },
  todo: { d: rect(3, 3, 13, 13, 1), lucide: "square" },
  heart: { fill: lucide("M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"), lucide: "heart" },
  hourglass: { d: lucide("M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"), lucide: "hourglass" },
  warning: { d: lucide("m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"), lucide: "triangle-alert" },
};
