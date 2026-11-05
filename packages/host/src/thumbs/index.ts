// Smaller copies of the board's big images, for the size they are shown at (the board asks with one of THUMB_WIDTHS: Card.tsx
// ImageView). A 2500 px screenshot shown 480 px wide costs the webview the same to decode, keep and draw as at full size, and a
// board of ten of them dragged at 45 fps; its 800 px copy is an eighth of that.
// The copies are a cache, never the user's files: they go in the editor's storage for this workspace (Workspace storage.dir(),
// thumbs/), not in the boards' folder, which is checked into the user's repository. Named by the image's content and the width,
// so every board and window showing the same image shares them, and a changed image gets new ones; copies not used for
// SWEEP_AGE are deleted.
// Made in a worker thread (thumbs/worker.ts, its path given to startHost), one at a time, so the host's event loop is never held
// by a decode; a host started without one (tests, the harness) makes them in its own thread
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { type Disposable, THUMB_WIDTHS, type Workspace } from "@codeboard/core";
import { Lru } from "../ws";
import { lookUp, runJob, type ThumbDone, type ThumbJob } from "./job";

export type { ThumbDone } from "./job";

/** Answers kept in memory (by file, its size and mtime, and the width) */
const MEMO = 500;
/** The worker stops after this long without work (it is started again for the next request) */
const WORKER_IDLE = 30_000;
/** Copies not used for this long are deleted */
const SWEEP_AGE = 60 * 24 * 3600_000;
/** A temporary file this old was left by a window that stopped while writing */
const TMP_AGE = 24 * 3600_000;

export class Thumbs implements Disposable {
  private memo = new Lru<Promise<ThumbDone | null>>(MEMO);
  private queue: Promise<unknown> = Promise.resolve();
  private worker: Worker | undefined;
  private calls = new Map<number, { ok: (d: ThumbDone | null) => void; fail: (e: Error) => void }>();
  private seq = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private swept = false;
  private gone = false;

  /** workerFile: the built worker (thumbs/worker.ts); none = made in this thread */
  constructor(
    private ws: Workspace,
    private workerFile?: string,
  ) {}

  /** The cache folder (the board views must be able to read it) */
  dir() {
    return path.join(this.ws.storage.dir(), "thumbs");
  }

  /** The copy of the image at abs that is width wide (one of THUMB_WIDTHS); null when abs is not a still PNG or JPEG */
  async get(abs: string, width: number): Promise<ThumbDone | null> {
    if (!THUMB_WIDTHS.includes(width)) throw new Error(`No thumbnail width ${width}`);
    if (this.gone) throw new Error("The host has stopped");
    const st = await fs.stat(abs);
    const key = `${abs}\0${st.size}\0${st.mtimeMs}\0${width}`;
    let p = this.memo.get(key);
    if (!p) {
      const job = { file: abs, width, dir: this.dir() };
      // a copy made before is found right away, beside the ones still being made; only making one waits its turn
      p = lookUp(job).then((l) => ("done" in l ? l.done : this.enqueue(job)));
      this.memo.set(key, p);
      p.catch(() => this.memo.delete(key));
    }
    if (!this.swept) {
      this.swept = true;
      void this.sweep().catch((e) => this.ws.log("warn", `thumbnail sweep: ${e instanceof Error ? e.message : e}`));
    }
    return p;
  }

  /** One job at a time: two big images decoded at once would hold two of them in memory for no gain */
  private enqueue(job: ThumbJob): Promise<ThumbDone | null> {
    const run = this.queue.then(() => (this.workerFile ? this.inWorker(job) : runJob(job)));
    this.queue = run.catch(() => {});
    return run;
  }

  private inWorker(job: ThumbJob): Promise<ThumbDone | null> {
    if (this.gone) return Promise.reject(new Error("The host has stopped"));
    clearTimeout(this.idle);
    const w = this.worker ?? this.start();
    const id = ++this.seq;
    return new Promise<ThumbDone | null>((ok, fail) => {
      this.calls.set(id, { ok, fail });
      w.postMessage({ id, job });
    }).finally(() => {
      if (!this.calls.size && this.worker === w) this.idle = setTimeout(() => this.stop(), WORKER_IDLE);
    });
  }

  private start(): Worker {
    const w = new Worker(this.workerFile!);
    // never what keeps the process (a test run, the extension host shutting down) alive
    w.unref();
    w.on("message", (m: { id: number; done?: ThumbDone | null; error?: string }) => {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (m.error !== undefined) c.fail(new Error(m.error));
      else c.ok(m.done ?? null);
    });
    const lost = (why: string) => {
      if (this.worker !== w) return;
      this.worker = undefined;
      for (const c of this.calls.values()) c.fail(new Error(why));
      this.calls.clear();
    };
    w.on("error", (e) => lost(e.message));
    w.on("exit", (code) => lost(`The thumbnail worker stopped (${code})`));
    this.worker = w;
    return w;
  }

  private stop() {
    const w = this.worker;
    this.worker = undefined;
    for (const c of this.calls.values()) c.fail(new Error("The host has stopped"));
    this.calls.clear();
    void w?.terminate();
  }

  /** Deletes the copies no board has asked for in SWEEP_AGE (each answer touches its copy) */
  private async sweep() {
    const dir = this.dir();
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const now = Date.now();
    for (const n of names) {
      const at = path.join(dir, n);
      const st = await fs.stat(at).catch(() => null);
      if (st && now - st.mtimeMs > (n.endsWith(".tmp") ? TMP_AGE : SWEEP_AGE)) await fs.rm(at, { force: true });
    }
  }

  dispose() {
    this.gone = true;
    clearTimeout(this.idle);
    this.stop();
    this.memo.clear();
  }
}
