// 编辑器要的小部件，用的一方也可以直接用（白板就用这一份，不另留一份）：输入框里的按键（不冒泡到外面，放行哪些由
// setKeyPassThrough 定）、浮层定位（@floating-ui/dom）、先读后写的 DOM 测量
export { keepKey, setKeyPassThrough } from "./editkeys";
export { place, virtual } from "./place";
export { queueMeasure, observeResize, setMeasureBatch } from "./measure";
// 灰字补全先停一下（拖动、改大小时）：Note 和代码编辑器里的都清掉、不问
export { holdGhosts } from "./ghost";
// 编辑器的固定等待（选中工具条在选区停住多久后出）
export { TOOLBAR_SETTLE } from "./timing";
