// Lucide 的造型（https://lucide.dev，ISC 许可），从 24 格按 2/3 缩到 16 格后重画，横竖线落在整数坐标上
// （1px 描边时 markdown.css 再平移半像素，见 .md-ico）。编辑器的工具条（editor/icons.tsx）和查找条（find.ts）共用。
// 路径表由 tools/icons/gen.mjs 从 tools/icons/icons.src.mjs（MD_ICONS）生成，别手改。
/** 名字后面的注释是 Lucide 里的原名 */
const P: Record<string, string> = {
  bold: "M4 8h6a2.5 2.5 0 0 1 0 5H4.5a.5 .5 0 0 1-.5-.5v-9a.5 .5 0 0 1 .5-.5H9a2.5 2.5 0 0 1 0 5", // bold
  italic: "M13 3H7M9 13H3M10 3 6 13", // italic
  strike: "M11 3H6.5a2.5 2.5 0 0 0-1.77 4.27M9.5 8a2.5 2.5 0 0 1 0 5H4M2 8h12", // strikethrough
  code: "M10.5 11.5 14 8l-3.5-3.5M5.5 4.5 2 8l3.5 3.5", // code
  link: "M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71L7.84 3.46M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14", // link
  highlight: "M14 8L11.707 10.293A1 1 0 0 1 10.293 10.293L7.707 7.707A1 1 0 0 1 7.707 6.293L11 3M7 8l-4 4v2h5l2-2", // highlighter
  math: "M12 5V3.5a.5 .5 0 0 0-.5-.5H4l4 5-4 5h7.5a.5 .5 0 0 0 .5-.5V11", // sigma
  annot: "M10.5 2.5l2.5 2.5L7 11H4.5V8.5zM2 14c1.3-.8 2.7-.8 4 0s2.7.8 4 0 2.7-.8 4 0", // pen with a squiggle
  up: "M4 10l4-4 4 4", // chevron-up
  down: "M4 6l4 4 4-4", // chevron-down
  close: "M12 4 4 12M4 4l8 8", // x
  replace: "M6 12l4-4-4-4", // chevron-right
  grid: "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2zM2 6h12M2 10h12M6 2v12M10 2v12", // grid-3x3
  rowAbove: "M2.5 8H13.5A.5 .5 0 0 1 14 8.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V8.5A.5 .5 0 0 1 2.5 8zM2 11h12M8 1v5M5.5 3.5h5", // between-horizontal-start
  rowBelow: "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V7.5A.5 .5 0 0 1 13.5 8H2.5A.5 .5 0 0 1 2 7.5V2.5A.5 .5 0 0 1 2.5 2zM2 5h12M8 10v5M5.5 12.5h5", // between-horizontal-end
  colLeft: "M8.5 2H13.5A.5 .5 0 0 1 14 2.5V13.5A.5 .5 0 0 1 13.5 14H8.5A.5 .5 0 0 1 8 13.5V2.5A.5 .5 0 0 1 8.5 2zM11 2v12M1 8h5M3.5 5.5v5", // between-vertical-start
  colRight: "M2.5 2H7.5A.5 .5 0 0 1 8 2.5V13.5A.5 .5 0 0 1 7.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2zM5 2v12M10 8h5M12.5 5.5v5", // between-vertical-end
  delRow: "M2.5 4H13.5A.5 .5 0 0 1 14 4.5V11.5A.5 .5 0 0 1 13.5 12H2.5A.5 .5 0 0 1 2 11.5V4.5A.5 .5 0 0 1 2.5 4zM6 6l4 4M10 6l-4 4", // rows-2 x
  delCol: "M4.5 2H11.5A.5 .5 0 0 1 12 2.5V13.5A.5 .5 0 0 1 11.5 14H4.5A.5 .5 0 0 1 4 13.5V2.5A.5 .5 0 0 1 4.5 2zM6 6l4 4M10 6l-4 4", // columns-2 x
  alignL: "M2 4h12M2 7h7M2 10h12M2 13h7", // align-left
  alignC: "M2 4h12M4.5 7h7M2 10h12M4.5 13h7", // align-center
  alignR: "M2 4h12M7 7h7M2 10h12M7 13h7", // align-right
  trash: "M2 4h12M6 7v4M10 7v4M13 4V13.5A.5 .5 0 0 1 12.5 14H3.5A.5 .5 0 0 1 3 13.5V4M6 4V2.5A.5 .5 0 0 1 6.5 2H9.5A.5 .5 0 0 1 10 2.5V4", // trash-2
  copy: "M6.5 6H13.5A.5 .5 0 0 1 14 6.5V13.5A.5 .5 0 0 1 13.5 14H6.5A.5 .5 0 0 1 6 13.5V6.5A.5 .5 0 0 1 6.5 6zM3 10H2.5A.5 .5 0 0 1 2 9.5V2.5A.5 .5 0 0 1 2.5 2H9.5A.5 .5 0 0 1 10 2.5V3", // copy
  check: "M13 4 6 11 3 8", // check
  wrap: "M2 4h12M2 12h4M2 8h9.5a2.5 2.5 0 0 1 0 5H9M10.5 11.5L9 13L10.5 14.5", // wrap-text
  dots: "M3 8h.01M8 8h.01M13 8h.01", // ellipsis
};

export type IconName = "bold" | "italic" | "strike" | "code" | "link" | "highlight" | "math" | "annot" | "up" | "down" | "close" | "replace"
  | "grid" | "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "delRow" | "delCol" | "alignL" | "alignC" | "alignR" | "trash" | "copy" | "check" | "wrap" | "dots";

export const iconPath = (name: IconName) => P[name];

/** 不用 Solid 的地方（查找条）画一个图标 */
export function iconEl(name: IconName): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
  svg.setAttribute("class", "md-ico");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", P[name]);
  svg.append(path);
  return svg;
}
