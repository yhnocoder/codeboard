// Background work shares the extension host's one thread with the boards. Work runs by priority: a click first, then the
// hover prefetch, then the board-open warm-up, then building the indexes. Lower priorities wait while higher ones run, but
// at most HOLD_MAX at a stretch, so a request stuck on the language server does not stop everything behind it.

export const Prio = { Click: 0, Hover: 1, Warm: 2, Index: 3 } as const;
export type Prio = (typeof Prio)[keyof typeof Prio];

/** How long higher-priority work holds lower priorities back at a stretch */
export const HOLD_MAX = 5000;
/** Long loops give the event loop back after this many milliseconds */
const SLICE_MS = 8;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** One turn of the event loop (no timer, so fake clocks do not stop it) */
const nextTurn = () => new Promise<void>((r) => setImmediate(r));

/** For long loops: call it often; every SLICE_MS it lets the event loop run */
export function slicer() {
  let t = performance.now();
  return async () => {
    if (performance.now() - t < SLICE_MS) return;
    await nextTurn();
    t = performance.now();
  };
}

// A stretch of work at one priority: it starts with the first job when none is open and ends when all jobs that joined
// it are done, or after HOLD_MAX. A job still running then counts only towards its own, already ended stretch.
type Stretch = { done: Promise<void>; end: () => void; jobs: number };

export class Scheduler {
  private open: (Stretch | undefined)[] = [];
  private busy = [0, 0, 0, 0];
  private queued = [0, 0, 0, 0];

  /** Runs fn at priority p: lower priorities wait for it (see HOLD_MAX) */
  async run<T>(p: Prio, fn: () => Promise<T>): Promise<T> {
    const s = this.stretch(p);
    s.jobs++;
    this.busy[p]++;
    try {
      return await fn();
    } finally {
      this.busy[p]--;
      if (--s.jobs === 0) s.end();
    }
  }

  private stretch(p: Prio): Stretch {
    const cur = this.open[p];
    if (cur) return cur;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const timer = setTimeout(() => s.end(), HOLD_MAX);
    const s: Stretch = {
      done,
      jobs: 0,
      end: () => {
        clearTimeout(timer);
        if (this.open[p] === s) this.open[p] = undefined;
        resolve();
      },
    };
    this.open[p] = s;
    return s;
  }

  /** Resolves once no work above priority p runs (at once when none does) */
  async clear(p: Prio): Promise<void> {
    for (;;) {
      const s = this.open.slice(0, p).find(Boolean);
      if (!s) return;
      await s.done;
    }
  }

  /**
   * A queue at priority p: at most `parallel` jobs run at once, and only the newest `keep` wait (older ones are dropped:
   * a hover that moved on). Failures are dropped too: this is for work whose result only warms caches.
   */
  lane(p: Prio, parallel: number, keep: number) {
    const queue: (() => Promise<unknown>)[] = [];
    let running = 0;
    const pump = () => {
      while (running < parallel && queue.length) {
        const job = queue.shift()!;
        running++;
        this.queued[p]--;
        void this.run(p, job)
          .catch(() => undefined)
          .finally(() => {
            running--;
            pump();
          });
      }
    };
    return (job: () => Promise<unknown>) => {
      queue.unshift(job);
      this.queued[p]++;
      if (queue.length > keep) {
        this.queued[p] -= queue.length - keep;
        queue.length = keep;
      }
      pump();
    };
  }

  /** Nothing at priority p runs or waits in a lane */
  idle(p: Prio): boolean {
    return !this.busy[p] && !this.queued[p];
  }
}
