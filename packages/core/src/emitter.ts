// 小事件发射器（宿主和以后的 macOS 版共用，不依赖 vscode.EventEmitter）。监听函数同步调用，一个出错不影响别的。

export type Disposable = { dispose(): void };
/** 订阅：返回 Disposable，dispose 后不再收到 */
export type Event<T> = (fn: (e: T) => void) => Disposable;

export class Emitter<T = void> {
  private fns = new Set<(e: T) => void>();
  readonly event: Event<T> = (fn) => {
    const f = (e: T) => fn(e); // 同一个函数订阅两次算两个
    this.fns.add(f);
    return { dispose: () => void this.fns.delete(f) };
  };
  fire(e: T) {
    for (const f of [...this.fns]) {
      try { f(e); } catch (err) { console.error("[codeboard] listener", err); }
    }
  }
  dispose() { this.fns.clear(); }
}
