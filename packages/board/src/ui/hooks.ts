// 列表浮层共用的两件事：↑↓ 选中（到头绕回来）、边输入边问宿主（等一下再问，旧的回答晚到时丢掉）
import { createEffect, createSignal, onCleanup } from "solid-js";

/** ↑↓ 在 count 项里移动选中，到头绕回来。key 处理了返回 true */
export function useListNav(count: () => number) {
  const [i, setI] = createSignal(0);
  const move = (d: number) => setI((x) => { const n = Math.max(1, count()); return (x + d + n) % n; });
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else return false;
    e.preventDefault();
    return true;
  };
  return { i, setI, key };
}

/** q 变了就等 wait(q) 毫秒再 fetch；回来时 q 又变过（或组件已卸下）就丢掉这次的回答。返回「正在问」 */
export function useDebouncedAsk<Q, R>(q: () => Q, fetch: (q: Q) => Promise<R>, done: (r: R) => void, wait: (q: Q) => number = () => 90) {
  const [busy, setBusy] = createSignal(false);
  let t: number | undefined, n = 0;
  createEffect(() => {
    const v = q();
    clearTimeout(t);
    const my = ++n;
    t = window.setTimeout(async () => {
      setBusy(true);
      const r = await fetch(v);
      if (my !== n) return;
      setBusy(false);
      done(r);
    }, wait(v));
  });
  onCleanup(() => { clearTimeout(t); n++; });
  return busy;
}
