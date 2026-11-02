// Small helpers the host's modules share; what needs the workspace is on HostContext (context.ts).
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { codeExts } from "@codeboard/analysis/langs";
import { escapeRegExp } from "@codeboard/analysis/basics";

export const posix = (p: string) => p.split(path.sep).join("/");

export const splitLines = (t: string) => t.split(/\r?\n/);

export async function exists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export const CODE_GLOB = `**/*.{${codeExts().join(",")}}`;
/** 不是项目自己代码的目录：依赖、虚拟环境、装好的包、构建输出、缓存。名字索引不建它们；里面的 .pyi 是库的存根 */
const NOT_PROJECT = [
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "site-packages",
  "build",
  "dist",
  "__pycache__",
  ".mypy_cache",
  ".tox",
];
export const CODE_EXCLUDE = `**/{${NOT_PROJECT.join(",")}}/**`;
const NOT_PROJECT_DIR = new RegExp(`[\\\\/](${NOT_PROJECT.map(escapeRegExp).join("|")})[\\\\/]`);
/** A path (from a workspace root, starting with a separator) goes through a folder CODE_EXCLUDE leaves out */
export const notProject = (p: string) => NOT_PROJECT_DIR.test(p);

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: NodeJS.Timeout | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string) {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
  clear() {
    this.m.clear();
  }
  keys() {
    return [...this.m.keys()];
  }
  has(k: string) {
    return this.m.has(k);
  }
  delete(k: string) {
    this.m.delete(k);
  }
}
