// 量 DOM（卡片尺寸、卡里每行的位置）：先把这一轮要量的都读完，再一起写回 store。
// 一边读一边写会让浏览器每张卡都重新排一次版，打开大白板时几百张卡就是几百次排版。
import { batch } from "solid-js";

type Read = () => (() => void) | void;
const queue = new Map<unknown, Read>();
let pending = false;

/** 排进这一轮（同一个 key 只量一次）：read 只读 DOM，返回的函数再写 store */
export function queueMeasure(key: unknown, read: Read) {
  queue.set(key, read);
  if (pending) return;
  pending = true;
  queueMicrotask(flush);
}
function flush() {
  pending = false;
  const reads = [...queue.values()];
  queue.clear();
  const writes = reads.map((r) => r());
  batch(() => { for (const w of writes) w?.(); });
}

// 所有卡共用一个 ResizeObserver：一帧里变了尺寸的元素在一次回调里一起报，正好一起量
const handlers = new Map<Element, Set<() => void>>();
const ro = new ResizeObserver((es) => { for (const e of es) handlers.get(e.target)?.forEach((f) => f()); });
export function observeResize(el: Element, f: () => void): () => void {
  let s = handlers.get(el);
  if (!s) { s = new Set(); handlers.set(el, s); ro.observe(el); }
  s.add(f);
  return () => {
    const t = handlers.get(el);
    if (!t) return;
    t.delete(f);
    if (!t.size) { handlers.delete(el); ro.unobserve(el); }
  };
}
