// 平移挡板：滚轮平移 / 缩放画布的这段手势里，世界层上面盖一块透明的 .pshield。
// 每个滚轮事件浏览器都要先找指针下面是谁（命中测试），镜头一动还要再找一遍更新悬停；指针下是空画布时它要把世界层里
// 每一个分层的东西（241 张卡、卡头里一个个 overflow / 定位的盒子）都问一遍：241 张卡的白板每次 ~2 ms（录 trace 时 3–5 ms），
// 占了平移每帧主线程时间的三分之一。盖上挡板，最上面这一块就挡住了，一次命中测试几乎不花时间。
// 手势里内容从指针下滑过本来也不该换悬停（hover.ts 镜头动的时候也不换；指针不动时 Chromium 本来也不给滑到下面的东西悬停）；
// 手势结束（WHEEL_GESTURE）、指针一动、按键时拿掉，指针这一动浏览器就按下面真正的东西给悬停。
// 挡板还在时按下（滚完马上点、拖）：先拿掉挡板，把这一下转给指针下面真正的元素（合成的 pointerdown，捕获阶段最先拦下原来那个，
// 别的监听只看到转过的这一下），它的 click 也转过去：浏览器把 click 发给按下和松开两处的共同祖先，按下记在挡板上就成了整块白板
import { WHEEL_GESTURE } from "../state/timing";

let el: HTMLElement | null = null, dropT: number | undefined, at = { x: 0, y: 0 };
// 转过去的这一下按在谁上、在谁上松开：click 要发给两者的共同祖先（和没有挡板时一样）
let fwd: Element | null = null, up: Element | null = null;

export function bindShield(e: HTMLElement) { el = e; }

export function dropShield() {
  clearTimeout(dropT);
  el?.classList.remove("on");
}

/** 这次滚轮手势在平移 / 缩放画布：盖上挡板，最后一个滚轮事件 WHEEL_GESTURE 后拿掉。from：事件落在的元素，挡板用它的光标 */
export function raiseShield(e: WheelEvent, from: Element) {
  if (!el) return;
  if (!el.classList.contains("on")) {
    el.style.cursor = getComputedStyle(from).cursor;
    el.classList.add("on");
  }
  at = { x: e.clientX, y: e.clientY };
  clearTimeout(dropT);
  dropT = window.setTimeout(dropShield, WHEEL_GESTURE);
}

const MODS = new Set(["Control", "Meta", "Shift", "Alt"]);
const common = (a: Element, b: Element) => { let p: Element | null = a; while (p && !p.contains(b)) p = p.parentElement; return p; };

/** 白板启动时最先调用一次：捕获阶段的监听按注册顺序跑，挡板上的按下要在别的监听之前转走 */
export function installShield() {
  window.addEventListener("pointerdown", (e) => {
    fwd = up = null;
    if (!el || e.target !== el) return;
    dropShield();
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || t === el) return;
    e.stopImmediatePropagation();
    t.dispatchEvent(new PointerEvent("pointerdown", e));
    fwd = t;
  }, true);
  window.addEventListener("pointermove", (e) => {
    if (e.target === el && (e.clientX !== at.x || e.clientY !== at.y)) dropShield();
  }, { capture: true, passive: true });
  // 快捷键按指针下面是谁找卡（⌥F Fit 指针下的卡）：按键时挡板先拿掉。只按修饰键不算：按住 ⌘ / Ctrl 滚轮缩放时它一直在重发
  window.addEventListener("keydown", (e) => { if (!MODS.has(e.key)) dropShield(); }, { capture: true, passive: true });
  window.addEventListener("pointerup", (e) => { if (fwd) up = e.target as Element; }, { capture: true, passive: true });
  // 右键：菜单事件是在按下时按挡板找的目标，挡板已经拿掉了，发给指针下面真正的元素
  window.addEventListener("contextmenu", (e) => {
    if (!el || e.target !== el) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || t === el) return;
    e.stopImmediatePropagation(); e.preventDefault();
    t.dispatchEvent(new MouseEvent("contextmenu", e));
  }, true);
  window.addEventListener("click", (e) => {
    const f = fwd, u = up;
    fwd = up = null;
    if (!f?.isConnected || !u?.isConnected) return;
    const want = common(f, u);
    if (!want || want === e.target || !(e.target as Node).contains(want)) return;
    e.stopImmediatePropagation();
    want.dispatchEvent(new PointerEvent("click", e));
  }, true);
}
