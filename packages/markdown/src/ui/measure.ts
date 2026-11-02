// 先把这一轮要量的都读完再一起写回：边读边写会让浏览器每读一次都重排一次版（大白板上几百张卡就是几百次）
type Read = () => (() => void) | void;

/** A page's measuring round and its one ResizeObserver: whoever measures on the page (the static render's diagrams, the
 *  caller's own layout) shares one, so all reads of a round come before all writes */
export type Measure = {
  /** 排进这一轮（同一个 key 只量一次）：read 只读 DOM，返回的函数再写 */
  queue(key: unknown, read: Read): void;
  /** f runs when el changes size (every element shares one ResizeObserver: a frame's changes come in one callback); returns
   *  the unsubscribe */
  observe(el: Element, f: () => void): () => void;
};

/** batch: wraps a round's writes (a store's batch, so it notifies once) */
export function createMeasure(batch: (run: () => void) => void = (f) => f()): Measure {
  const queue = new Map<unknown, Read>();
  let pending = false;
  const flush = () => {
    pending = false;
    const reads = [...queue.values()];
    queue.clear();
    const writes = reads.map((r) => r());
    batch(() => {
      for (const w of writes) w?.();
    });
  };
  const handlers = new Map<Element, Set<() => void>>();
  let ro: ResizeObserver | undefined;
  return {
    queue(key, read) {
      queue.set(key, read);
      if (pending) return;
      pending = true;
      queueMicrotask(flush);
    },
    observe(el, f) {
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
    },
  };
}
