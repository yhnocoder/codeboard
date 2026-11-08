// What the shell gives the bridge: a synchronous file system, a clock, and a way to send events back. The Swift app installs it
// as `globalThis.native` before the bundle runs (JSBridge.swift); the tests give a Node one (test/node-native.ts).
// Every call is synchronous and returns plain values; file errors come back as `{ error }` so no exception crosses the boundary.

export type NativeEnt = { name: string; isFile: boolean; isDir: boolean };
export type NativeStat = { mtimeMs: number; birthtimeMs: number; ctimeMs: number };
export type NativeErr = { error: string };

export interface Native {
  readdir(dir: string): NativeEnt[] | NativeErr;
  stat(p: string): NativeStat | NativeErr;
  readFile(p: string): string | NativeErr;
  /** The file's bytes as base64 (the tree-sitter wasm) */
  readBinary(p: string): string | NativeErr;
  /** text, or bytes as base64 when `base64` is set */
  writeFile(p: string, data: string, base64: boolean): null | NativeErr;
  rename(from: string, to: string): null | NativeErr;
  rm(p: string): null | NativeErr;
  rmdir(p: string): null | NativeErr;
  mkdir(p: string): null | NativeErr;
  sha1(base64: string): string;
  /** SHA-256 of a string's UTF-8, hex (a data: URL picture's key, as the host's meaning.ts makes it) */
  sha256(text: string): string;
  /** A file's bytes as base64 (a picture for the index) */
  readBase64(p: string): string | NativeErr;
  /** The cameras of every board, kept by the shell (one store per process, every window's): the camera as JSON, or null */
  camGet(board: string): string | null;
  camSet(board: string, json: string): void;
  /** Watch a folder tree; changed paths arrive through `CodeBoard.fsChanged(id, abs)`. Returns the watch id */
  watch(base: string): number;
  unwatch(id: number): void;
  /** Ask the user: the option's index, or null when dismissed, to `done` once the shell has asked (never inside this call) */
  choose(title: string, options: string[], text: string, done: (i: number | null) => void): void;
  /** Milliseconds, monotonic, with sub-millisecond precision */
  now(): number;
  /** An event for the shell: a JSON string */
  emit(name: string, json: string): void;
  /** A timer the shell fires through `CodeBoard.timer(id)`; cancelTimer stops it */
  setTimer(id: number, ms: number): void;
  cancelTimer(id: number): void;
}

export const isErr = (x: unknown): x is NativeErr => typeof x === "object" && x !== null && "error" in x;

/** Timers and microtasks the bundled code expects (setTimeout…), on the shell's timer. Call once before anything else */
export function installGlobals(
  native: Native,
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
) {
  const timers = new Map<number, () => void>();
  let next = 1;
  const setT = (fn: () => void, ms = 0, repeat = false) => {
    const id = next++;
    const run = () => {
      if (repeat) native.setTimer(id, ms);
      else timers.delete(id);
      fn();
    };
    timers.set(id, run);
    native.setTimer(id, Math.max(0, ms));
    return id;
  };
  const clearT = (id: unknown) => {
    if (typeof id !== "number") return;
    timers.delete(id);
    native.cancelTimer(id);
  };
  g.setTimeout = (fn: () => void, ms = 0) => setT(fn, ms, false);
  g.setInterval = (fn: () => void, ms = 0) => setT(fn, ms, true);
  g.clearTimeout = clearT;
  g.clearInterval = clearT;
  if (typeof g.queueMicrotask !== "function") g.queueMicrotask = (fn: () => void) => void Promise.resolve().then(fn);
  if (typeof g.structuredClone !== "function") g.structuredClone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  if (typeof g.performance !== "object") g.performance = { now: () => native.now() };
  // JavaScriptCore on its own has no atob / btoa (the Fs port's bytes cross as base64)
  if (typeof g.btoa !== "function") g.btoa = btoa;
  if (typeof g.atob !== "function") g.atob = atob;
  return {
    /** The shell's timer `id` fired */
    fire(id: number) {
      timers.get(id)?.();
    },
  };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function btoa(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i),
      b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN,
      c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out +=
      B64[n >> 18] +
      B64[(n >> 12) & 63] +
      (Number.isNaN(b) ? "=" : B64[(n >> 6) & 63]) +
      (Number.isNaN(c) ? "=" : B64[n & 63]);
  }
  return out;
}
function atob(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | (i + k < clean.length ? B64.indexOf(clean[i + k]) : 0), 0);
    const bytes = [(n >> 16) & 255, (n >> 8) & 255, n & 255].slice(
      0,
      Math.min(3, Math.floor(((clean.length - i) * 3) / 4)),
    );
    out += String.fromCharCode(...bytes);
  }
  return out;
}
