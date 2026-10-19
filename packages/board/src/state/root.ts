// 模块级的单例：memo / effect 都挂在同一个根下（整个 webview 活多久它们活多久，也不报「没有 owner」）；
// 换白板时要清掉的界面状态各自登记一个重置函数，hostio 收到 init 时一起调。
import { batch, createRoot, getOwner, runWithOwner, type Owner } from "solid-js";

let owner!: Owner;
createRoot(() => { owner = getOwner()!; });

/** 在共用的根下建模块级的 memo / effect：rooted(() => createMemo(...)) */
export const rooted = <T>(fn: () => T): T => runWithOwner(owner, fn) as T;

const resets: (() => void)[] = [];
/** 换了一块白板（进入 / 离开子白板、打开别的白板）时要做的重置 */
export function onBoardSwitch(fn: () => void) { resets.push(fn); }
/** hostio 的 init 调：所有登记过的重置一起做 */
export function boardSwitched() { batch(() => { for (const f of resets) f(); }); }
