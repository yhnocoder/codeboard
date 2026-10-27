import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Workspace } from "@codeboard/core";
import { codeExts, langOfExt } from "@codeboard/analysis/langs";

let current: Workspace | undefined;
export function useWorkspace(w: Workspace) { current = w; }
export function workspace(): Workspace {
  if (!current) throw new Error("Workspace not set");
  return current;
}
export const hasWorkspace = () => !!current;

export const wsRoots = () => workspace().files.roots();
/** 第一个工作区根：Source.repo 相对它 */
export const ws0 = () => wsRoots()[0] ?? "";
/** 设置里写的文件夹：~ 开头的在主目录下，相对路径相对第一个工作区根（没有工作区时相对主目录） */
export const settingDir = (p: string) => path.resolve(ws0() || os.homedir(), p.replace(/^~(?=$|[\\/])/, os.homedir()));
export const posix = (p: string) => p.split(path.sep).join("/");

/** 显示 / 往返用的路径：在第一个根下面就写相对路径，否则写绝对路径 */
export function hostPath(abs: string): string {
  const r = ws0() ? path.relative(ws0(), abs) : abs;
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? posix(r) : abs;
}
export const fromHostPath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(ws0(), p));

export const inWorkspace = (abs: string) => wsRoots().some((f) => {
  const r = path.relative(f, abs);
  return !r.startsWith("..") && !path.isAbsolute(r);
});

/** 文件当前内容：编辑器里有未保存的改动就用编辑器的，否则读磁盘（文件删了 = null，哪怕编辑器里还开着）。track = 记进最近读过的文件 */
export async function readText(abs: string, track = true): Promise<string | null> {
  if (track) recent.set(abs, true);
  const unsaved = workspace().files.unsavedText(abs);
  if (unsaved !== undefined) return unsaved;
  try { return await fs.readFile(abs, "utf8"); } catch { return null; }
}
/** 最近读过的文件（不扫工作区的兜底查找用）。Lru 在本文件后面定义，用到时才建 */
let recentLru: Lru<true> | undefined;
const recent = { set: (k: string, v: true) => (recentLru ??= new Lru<true>(80)).set(k, v) };
export const recentFiles = (): string[] => (recentLru ? recentLru.keys() : []);

export const splitLines = (t: string) => t.split(/\r?\n/);

export async function exists(p: string) {
  try { await fs.stat(p); return true; } catch { return false; }
}

export function langOf(file: string): string {
  const open = workspace().files.openLanguage(file);
  if (open && open !== "plaintext") return open;
  return langOfExt(file)?.id ?? "plaintext";
}

export const CODE_GLOB = `**/*.{${codeExts().join(",")}}`;
export const CODE_EXCLUDE = "**/{node_modules,.git,.venv,venv,build,dist,__pycache__,.mypy_cache,.tox}/**";

export function mkUid(p: string) {
  return `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: NodeJS.Timeout | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string) {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
  clear() { this.m.clear(); }
  keys() { return [...this.m.keys()]; }
  has(k: string) { return this.m.has(k); }
  delete(k: string) { this.m.delete(k); }
}
