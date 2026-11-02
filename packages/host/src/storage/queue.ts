// Writes to the storage folder one after another (two boards saving at once merge the shared card files in order), and
// each board's changes gathered for a while before they are written.

export class WriteQueue {
  private q: Promise<unknown> = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Runs fn after everything queued before it */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.q.then(fn);
    this.q = r.catch(() => undefined);
    return r;
  }

  /** Runs fn for this key in ms, unless asked again before (then the later time counts) */
  later(key: string, ms: number, fn: () => void) {
    this.cancel(key);
    this.timers.set(key, setTimeout(fn, ms));
  }

  cancel(key: string) {
    clearTimeout(this.timers.get(key));
  }
}
