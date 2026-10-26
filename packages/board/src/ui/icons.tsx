// 线条图标：Lucide 的造型（https://lucide.dev，ISC 许可，部分来自 Feather，MIT；全文见 public/icons/LICENSE-lucide.txt），
// 从 24 格按 2/3 缩到 16 格后逐个重画：横竖线都落在整数坐标上（2px 描边正好盖满两行像素），圆和圆角的切点也落在整数上。
// 1px 主题由 styles.css 把整组描边平移 (-.5, -.5)，线就落在半像素中心上，1x / 2x 屏都不糊；一套坐标管两种线宽。
// 填色的小方块（⋯ 的三个点、贴纸脸上的眼睛）不跟着平移，本身就在整像素上。
// 路径表由 tools/icons/gen.mjs 从 tools/icons/icons.src.mjs 生成，别手改；改完跑 node tools/icons/check.mjs：查网格规则、量发虚像素占比、可出对比图。
import type { JSX } from "solid-js";

/** 描边路径；名字后面的注释是 Lucide 里的原名 */
const P: Record<string, string> = {
  plus: "M8 3v10M3 8h10", // plus
  minus: "M3 8h10", // minus
  fit: "M2 5V2.5A.5 .5 0 0 1 2.5 2H5M11 2H13.5A.5 .5 0 0 1 14 2.5V5M14 11V13.5A.5 .5 0 0 1 13.5 14H11M5 14H2.5A.5 .5 0 0 1 2 13.5V11", // scan
  chev: "M4 6l4 4 4-4", // chevron-down
  chevR: "M6 12l4-4-4-4", // chevron-right
  left: "M10 12 6 8l4-4", // chevron-left
  right: "M6 12l4-4-4-4", // chevron-right
  close: "M12 4 4 12M4 4l8 8", // x
  play: "M4.743 3.413L12.213 7.563A.5 .5 0 0 1 12.213 8.437L4.743 12.587A.5 .5 0 0 1 4 12.15V3.85A.5 .5 0 0 1 4.743 3.413z", // play
  entry: "M7 11l3-3-3-3M10 8H2M10 2H13.5A.5 .5 0 0 1 14 2.5V13.5A.5 .5 0 0 1 13.5 14H10", // log-in
  search: "M12 7A5 5 0 1 1 2 7A5 5 0 1 1 12 7ZM10.6 10.6L14 14", // search
  note: "M10 2L14 6V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2H10zM10 2V5.5A.5 .5 0 0 0 10.5 6H14", // sticky-note
  code: "M10.5 11.5 14 8l-3.5-3.5M5.5 4.5 2 8l3.5 3.5", // code
  image: "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2zM7 6A1 1 0 1 1 5 6A1 1 0 1 1 7 6ZM14 10l-2.3-2.3a1 1 0 0 0-1.4 0L4 14", // image
  web: "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8ZM8 2a10 10 0 0 0 0 12 10 10 0 0 0 0-12M2 8h12", // globe
  section: "M2.5 3H7L8.5 5H13.5A.5 .5 0 0 1 14 5.5V12.5A.5 .5 0 0 1 13.5 13H2.5A.5 .5 0 0 1 2 12.5V3.5A.5 .5 0 0 1 2.5 3z", // folder
  link: "M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71L7.84 3.46M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14", // link
  text: "M8 3v10M6 13h4M3 5V3.5A.5 .5 0 0 1 3.5 3H12.5A.5 .5 0 0 1 13 3.5V5", // type
  mark: "M10.5 2.5l2.5 2.5L7 11H4.5V8.5zM2 14c1.3-.8 2.7-.8 4 0s2.7.8 4 0 2.7-.8 4 0", // pen with a squiggle
  undo: "M6 10 2 6l4-4M2 6h7.5a3.5 3.5 0 0 1 0 7H7", // undo-2
  redo: "M10 10l4-4-4-4M14 6H6.5a3.5 3.5 0 0 0 0 7H9", // redo-2
  lock: "M2.5 7H13.5A.5 .5 0 0 1 14 7.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V7.5A.5 .5 0 0 1 2.5 7zM5 7V5a3 3 0 0 1 6 0v2", // lock
  unlock: "M2.5 7H13.5A.5 .5 0 0 1 14 7.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V7.5A.5 .5 0 0 1 2.5 7zM5 7V5a3 3 0 0 1 5.94-.6", // lock-open
  loop: "M14 8a6 6 0 1 1-6-6c1.7 0 3.3.7 4.5 1.8L14 5M14 2v3h-3", // rotate-cw
  layout: "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2zM6 2v12", // panel-left
  focus: "M10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8ZM2 5V2.5A.5 .5 0 0 1 2.5 2H5M11 2H13.5A.5 .5 0 0 1 14 2.5V5M14 11V13.5A.5 .5 0 0 1 13.5 14H11M5 14H2.5A.5 .5 0 0 1 2 13.5V11", // focus
  pin: "M6 2h4a1 1 0 0 1 0 2H6a1 1 0 0 1 0-2zM6 4v3.5L3.5 9.6a1 1 0 0 0-.5.9v.5h10v-.5a1 1 0 0 0-.5-.9L10 7.5V4M8 11v3", // pin
  eye: "M1.5 8a6.73 6.73 0 0 1 13 0 6.73 6.73 0 0 1-13 0zM10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8Z", // eye
  swap: "M11 2l3 3-3 3M14 5H2M5 14l-3-3 3-3M2 11h12", // arrow-right-left
  check: "M13 4 6 11 3 8", // check
  alignL: "M2 1v14M5.5 2H13.5A.5 .5 0 0 1 14 2.5V5.5A.5 .5 0 0 1 13.5 6H5.5A.5 .5 0 0 1 5 5.5V2.5A.5 .5 0 0 1 5.5 2zM5.5 10H10.5A.5 .5 0 0 1 11 10.5V13.5A.5 .5 0 0 1 10.5 14H5.5A.5 .5 0 0 1 5 13.5V10.5A.5 .5 0 0 1 5.5 10z", // align-start-vertical
  alignC: "M8 1v1M8 6v4M8 14v1M2.5 2H13.5A.5 .5 0 0 1 14 2.5V5.5A.5 .5 0 0 1 13.5 6H2.5A.5 .5 0 0 1 2 5.5V2.5A.5 .5 0 0 1 2.5 2zM4.5 10H11.5A.5 .5 0 0 1 12 10.5V13.5A.5 .5 0 0 1 11.5 14H4.5A.5 .5 0 0 1 4 13.5V10.5A.5 .5 0 0 1 4.5 10z", // align-center-vertical
  alignR: "M14 1v14M2.5 2H10.5A.5 .5 0 0 1 11 2.5V5.5A.5 .5 0 0 1 10.5 6H2.5A.5 .5 0 0 1 2 5.5V2.5A.5 .5 0 0 1 2.5 2zM5.5 10H10.5A.5 .5 0 0 1 11 10.5V13.5A.5 .5 0 0 1 10.5 14H5.5A.5 .5 0 0 1 5 13.5V10.5A.5 .5 0 0 1 5.5 10z", // align-end-vertical
  alignT: "M1 2h14M2.5 5H5.5A.5 .5 0 0 1 6 5.5V13.5A.5 .5 0 0 1 5.5 14H2.5A.5 .5 0 0 1 2 13.5V5.5A.5 .5 0 0 1 2.5 5zM10.5 5H13.5A.5 .5 0 0 1 14 5.5V10.5A.5 .5 0 0 1 13.5 11H10.5A.5 .5 0 0 1 10 10.5V5.5A.5 .5 0 0 1 10.5 5z", // align-start-horizontal
  alignB: "M1 14h14M2.5 2H5.5A.5 .5 0 0 1 6 2.5V10.5A.5 .5 0 0 1 5.5 11H2.5A.5 .5 0 0 1 2 10.5V2.5A.5 .5 0 0 1 2.5 2zM10.5 5H13.5A.5 .5 0 0 1 14 5.5V10.5A.5 .5 0 0 1 13.5 11H10.5A.5 .5 0 0 1 10 10.5V5.5A.5 .5 0 0 1 10.5 5z", // align-end-horizontal
  distH: "M2 2v12M14 2v12M6.5 4H9.5A.5 .5 0 0 1 10 4.5V11.5A.5 .5 0 0 1 9.5 12H6.5A.5 .5 0 0 1 6 11.5V4.5A.5 .5 0 0 1 6.5 4z", // align-horizontal-space-around
  distV: "M2 2h12M2 14h12M4.5 6H11.5A.5 .5 0 0 1 12 6.5V9.5A.5 .5 0 0 1 11.5 10H4.5A.5 .5 0 0 1 4 9.5V6.5A.5 .5 0 0 1 4.5 6z", // align-vertical-space-around
  sameW: "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V5.5A.5 .5 0 0 1 13.5 6H2.5A.5 .5 0 0 1 2 5.5V2.5A.5 .5 0 0 1 2.5 2zM2.5 10H13.5A.5 .5 0 0 1 14 10.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V10.5A.5 .5 0 0 1 2.5 10z", // stretch-horizontal
  external: "M10 2h4v4M14 2 7 9M12 9V13.5A.5 .5 0 0 1 11.5 14H2.5A.5 .5 0 0 1 2 13.5V4.5A.5 .5 0 0 1 2.5 4H7", // external-link
  newSection: "M4 3H12A2 2 0 0 1 14 5V11A2 2 0 0 1 12 13H4A2 2 0 0 1 2 11V5A2 2 0 0 1 4 3zM2 6h12", // Section frame with a title bar (multi-select toolbar)
  subBoard: "M4 2H12A2 2 0 0 1 14 4V12A2 2 0 0 1 12 14H4A2 2 0 0 1 2 12V4A2 2 0 0 1 4 2zM6 5H10A1 1 0 0 1 11 6V10A1 1 0 0 1 10 11H6A1 1 0 0 1 5 10V6A1 1 0 0 1 6 5z", // board in a board (multi-select toolbar)
  tidy: "M3 2H5A1 1 0 0 1 6 3V5A1 1 0 0 1 5 6H3A1 1 0 0 1 2 5V3A1 1 0 0 1 3 2zM11 2H13A1 1 0 0 1 14 3V5A1 1 0 0 1 13 6H11A1 1 0 0 1 10 5V3A1 1 0 0 1 11 2zM3 10H5A1 1 0 0 1 6 11V13A1 1 0 0 1 5 14H3A1 1 0 0 1 2 13V11A1 1 0 0 1 3 10zM11 10H13A1 1 0 0 1 14 11V13A1 1 0 0 1 13 14H11A1 1 0 0 1 10 13V11A1 1 0 0 1 11 10z", // layout-grid
  copy: "M6.5 6H13.5A.5 .5 0 0 1 14 6.5V13.5A.5 .5 0 0 1 13.5 14H6.5A.5 .5 0 0 1 6 13.5V6.5A.5 .5 0 0 1 6.5 6zM3 10H2.5A.5 .5 0 0 1 2 9.5V2.5A.5 .5 0 0 1 2.5 2H9.5A.5 .5 0 0 1 10 2.5V3", // copy
  boards: "M2 7V2.5A.5 .5 0 0 1 2.5 2H7M5 10V5.5A.5 .5 0 0 1 5.5 5H10M8.5 8H13.5A.5 .5 0 0 1 14 8.5V13.5A.5 .5 0 0 1 13.5 14H8.5A.5 .5 0 0 1 8 13.5V8.5A.5 .5 0 0 1 8.5 8z", // square-stack
  trash: "M2 4h12M6 7v4M10 7v4M13 4V13.5A.5 .5 0 0 1 12.5 14H3.5A.5 .5 0 0 1 3 13.5V4M6 4V2.5A.5 .5 0 0 1 6.5 2H9.5A.5 .5 0 0 1 10 2.5V4", // trash-2
  compact: "M2 4h12M2 8h12M2 12h12", // menu
  rich: "M2.5 2H5.5A.5 .5 0 0 1 6 2.5V5.5A.5 .5 0 0 1 5.5 6H2.5A.5 .5 0 0 1 2 5.5V2.5A.5 .5 0 0 1 2.5 2zM2.5 10H5.5A.5 .5 0 0 1 6 10.5V13.5A.5 .5 0 0 1 5.5 14H2.5A.5 .5 0 0 1 2 13.5V10.5A.5 .5 0 0 1 2.5 10zM9 3h5M9 6h5M9 11h5M9 14h5", // layout-list
  sticker: "M10 2L14 6V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2H10zM10 2V5.5A.5 .5 0 0 0 10.5 6H14M6 11c1.2 1 2.8 1 4 0", // sticker
  clock: "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8ZM8 5v3l2.5 1.5", // clock
  arrowR: "M3 8h10M9 4l4 4-4 4", // arrow-right
  arrowLink: "M6 12A2 2 0 1 1 2 12A2 2 0 1 1 6 12ZM4 10V9a5 5 0 0 1 5-5h5M11 1l3 3-3 3", // custom: ring with a bent arrow
  question: "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8ZM6.5 6.5a1.5 1.5 0 0 1 3 0c0 1-1.5 1.5-1.5 2.5", // circle-help
  export: "M8 2v8M5 5l3-3 3 3M3 8V13.5A.5 .5 0 0 0 3.5 14H12.5A.5 .5 0 0 0 13 13.5V8", // share
};
/** 填色：整像素上的小方块，1px / 2px 主题都一样 */
const F: Record<string, string> = {
  more: "M2 7h2v2H2zM7 7h2v2H7zM12 7h2v2h-2z", // ellipsis
  dot: "M7 7h2v2H7z", // dot
  sticker: "M5 7h2v2H5zM9 7h2v2H9z", // sticker
  question: "M7 11h2v2H7z", // circle-help
};

export function Icon(p: { name: keyof typeof P | string; size?: number; class?: string; style?: JSX.CSSProperties }) {
  return (
    <svg class={`ico ${p.class ?? ""}`} viewBox="0 0 16 16" width={p.size ?? 16} height={p.size ?? 16} aria-hidden="true" style={p.style}>
      {P[p.name] ? <path d={P[p.name]} /> : null}
      {F[p.name] ? <path class="f" d={F[p.name]} /> : null}
    </svg>
  );
}
/** 同一套图标拼成 SVG 字符串：整块用 innerHTML 放进去的地方用（子白板框里的小卡片） */
export const iconHtml = (name: string, size = 16) =>
  `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${P[name] ? `<path d="${P[name]}"/>` : ""}${F[name] ? `<path class="f" d="${F[name]}"/>` : ""}</svg>`;
