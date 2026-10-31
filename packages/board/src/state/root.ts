// 模块级的单例：memo / effect 都挂在同一个根下（整个 webview 活多久它们活多久，也不报「没有 owner」）。
// 属于当前白板的临时界面状态用 boardSignal 声明，换白板时自己回到初值；跨白板留着的（设置、toast……）用 createSignal。
// 不是 signal 的重置（作废请求、清导航栈）登记 onBoardSwitch。hostio 收到 init 时一起做
import {
  batch,
  createRoot,
  createSignal,
  getOwner,
  runWithOwner,
  type Owner,
  type Signal,
  type SignalOptions,
} from "solid-js";

let owner!: Owner;
createRoot(() => {
  owner = getOwner()!;
});

/** 在共用的根下建模块级的 memo / effect：rooted(() => createMemo(...)) */
export const rooted = <T>(fn: () => T): T => runWithOwner(owner, fn) as T;

const resets: (() => void)[] = [];
/** 换了一块白板（进入 / 离开子白板、打开别的白板）时要做的、不是 signal 的重置 */
export function onBoardSwitch(fn: () => void) {
  resets.push(fn);
}
/** 这块白板的临时状态（选中的行、拖动中、悬停、正在编辑……）：换白板时回到 init */
export function boardSignal<T>(init: T, o?: SignalOptions<T>): Signal<T> {
  const s = createSignal(init, o);
  resets.push(() => s[1](() => init));
  return s;
}
export function boardSwitched() {
  batch(() => {
    for (const f of resets) f();
  });
}
