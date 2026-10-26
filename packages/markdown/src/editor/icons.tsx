// Lucide 的造型（https://lucide.dev，ISC 许可），从 24 格按 2/3 缩到 16 格后重画，横竖线落在整数坐标上
// （1px 描边时 markdown.css 再平移半像素，见 .md-ico）。
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
};

export type IconName = "bold" | "italic" | "strike" | "code" | "link" | "highlight" | "math" | "annot";

export const Icon = (p: { name: IconName }) => (
  <svg class="md-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={P[p.name]} /></svg>
);
