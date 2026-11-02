// 模块级的单例：memo / effect 都挂在同一个根下（整个 webview 活多久它们活多久，也不报「没有 owner」）。
// 属于当前白板的状态用下面的 board* 声明，换白板时自己回到初值（signal、store、Map / Set、计时器、普通的值）；
// 跨白板留着的（设置、toast、按内容的缓存……）用 createSignal 等，test/unit/state-shape.test.ts 按形状检查模块顶层没有别的。
// 别的重置（作废请求、清导航栈）登记 onBoardSwitch。hostio 收到 init 时一起做
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
import { createStore, produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store";

let owner!: Owner;
createRoot(() => {
  owner = getOwner()!;
});

/** 在共用的根下建模块级的 memo / effect：rooted(() => createMemo(...)) */
export const rooted = <T>(fn: () => T): T => runWithOwner(owner, fn) as T;

const resets: (() => void)[] = [];
/** 换了一块白板（进入 / 离开子白板、打开别的白板）时要做的、下面几样以外的重置 */
export function onBoardSwitch(fn: () => void) {
  resets.push(fn);
}
/** 这块白板的临时状态（选中的行、拖动中、悬停、正在编辑……）：换白板时回到 init */
export function boardSignal<T>(init: T, o?: SignalOptions<T>): Signal<T> {
  const s = createSignal(init, o);
  resets.push(() => s[1](() => init));
  return s;
}
/**
 * 这块白板的 store：换白板时回到 init()。按 id 存的、由挂着的组件量出来的（卡的尺寸、行的位置）传 keep：
 * 新白板上还有的那几项留着（同一个 id 的卡换白板时组件不重建，不会再量一遍），别的去掉
 */
export function boardStore<T extends object>(
  init: () => T,
  keep?: (key: string) => boolean,
): [get: Store<T>, set: SetStoreFunction<T>] {
  const [get, set] = createStore<T>(init());
  resets.push(
    keep
      ? () =>
          set(
            produce((s) => {
              for (const k of Object.keys(s)) if (!keep(k)) delete (s as Record<string, unknown>)[k];
            }),
          )
      : () => set(reconcile(init())),
  );
  return [get, set];
}
/** 这块白板的 Map：换白板时清空（keep 同 boardStore） */
export function boardMap<K, V>(keep?: (key: K) => boolean): Map<K, V> {
  const m = new Map<K, V>();
  resets.push(() => {
    if (!keep) return m.clear();
    for (const k of [...m.keys()]) if (!keep(k)) m.delete(k);
  });
  return m;
}
/** 这块白板的 Set：换白板时清空 */
export function boardSet<T>(): Set<T> {
  const s = new Set<T>();
  resets.push(() => s.clear());
  return s;
}
/** 这块白板的一个普通的值（拖动、按键中途记下的）：换白板时回到 init */
export function boardRef<T>(init: T): { v: T } {
  const r = { v: init };
  resets.push(() => {
    r.v = init;
  });
  return r;
}
export type BoardTimer = {
  /** 重新计时：之前在等的不再跑 */
  start(fn: () => void, ms: number): void;
  stop(): void;
  /** 在等（start 了、还没到点也没 stop） */
  readonly pending: boolean;
};
/** 这块白板的一个计时器：换白板时取消，到点的 fn 不会对新白板做什么 */
export function boardTimer(): BoardTimer {
  let id: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(id);
    id = undefined;
  };
  resets.push(stop);
  return {
    start(fn, ms) {
      clearTimeout(id);
      id = setTimeout(() => {
        id = undefined;
        fn();
      }, ms);
    },
    stop,
    get pending() {
      return id !== undefined;
    },
  };
}
export function boardSwitched() {
  batch(() => {
    for (const f of resets) f();
  });
}
