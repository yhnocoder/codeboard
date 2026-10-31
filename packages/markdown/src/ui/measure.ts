// 先把这一轮要量的都读完再一起写回：边读边写会让浏览器每读一次都重排一次版（大白板上几百张卡就是几百次）
type Read = () => (() => void) | void;
const queue = new Map<unknown, Read>();
let pending = false;
let wrap = (f: () => void) => f();
/** 一轮的写回包在 f 里做（白板：Solid 的 batch，写 store 只通知一次） */
export const setMeasureBatch = (f: (run: () => void) => void) => {
  wrap = f;
};

/** 排进这一轮（同一个 key 只量一次）：read 只读 DOM，返回的函数再写 */
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
  wrap(() => {
    for (const w of writes) w?.();
  });
}

// 所有元素共用一个 ResizeObserver：一帧里变了尺寸的元素在一次回调里一起报，正好一起量
const handlers = new Map<Element, Set<() => void>>();
let ro: ResizeObserver | undefined;
export function observeResize(el: Element, f: () => void): () => void {
  ro ??= new ResizeObserver((es) => {
    for (const e of es) handlers.get(e.target)?.forEach((h) => h());
  });
  let s = handlers.get(el);
  if (!s) {
    s = new Set();
    handlers.set(el, s);
    ro.observe(el);
  }
  s.add(f);
  return () => {
    const t = handlers.get(el);
    if (!t) return;
    t.delete(f);
    if (!t.size) {
      handlers.delete(el);
      ro!.unobserve(el);
    }
  };
}
