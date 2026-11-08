// The parsers, languages and queries are loaded once per process. A TreeCache keeps the last tree of each key (usually a file
// path): when the text changed it is edited and parsed incrementally, when it did not it is reused.
import TS from "@vscode/tree-sitter-wasm";
import type { Parser as TSParser, Language as TSLanguage, Tree, Edit, Query } from "@vscode/tree-sitter-wasm";

import type { Grammar } from "./langs";
export type { Edit, Grammar };

let runtime: Promise<void> | undefined;
const langs = new Map<Grammar, TSLanguage>();
const loading = new Map<Grammar, Promise<void>>();
let wasmDir: string | undefined;
let reader: WasmReader | undefined;

/**
 * 宿主启动时调用一次；dir = 放全部 wasm 的目录（插件的 dist/）。
 * Node 下不给：运行时和 Python / Rust 语法用 @vscode/tree-sitter-wasm 里的，C / C++ / CUDA 用 @yhnocoder/tree-sitter-cuda 里的。
 * grammars = 只装这几种语法（没给就全部）；每种只装一次，再叫到时直接等它装好
 */
export function initAnalysis(dir?: string | WasmReader, grammars?: readonly Grammar[]): Promise<void> {
  if (typeof dir === "string") wasmDir = dir;
  if (typeof dir === "function") reader = dir;
  const read = reader;
  runtime ??= (async () => {
    // the runtime's bytes: Emscripten's `wasmBinary`, which web-tree-sitter's init passes through but does not declare; locateFile
    // keeps it from building a URL for the file it already has (JavaScriptCore has no URL)
    if (read) {
      const init = { wasmBinary: await read("tree-sitter.wasm"), locateFile: (f: string) => f };
      await TS.Parser.init(init as Parameters<typeof TS.Parser.init>[0]);
    } else await TS.Parser.init({ locateFile: (f: string) => wasmPath(f) });
  })();
  const want = grammars ?? WASM.map(([g]) => g);
  return Promise.all(
    want.map((g) => {
      let p = loading.get(g);
      if (!p) {
        const f = WASM.find(([k]) => k === g)?.[1];
        if (!f) throw new Error(`no grammar for ${g}`);
        p = runtime!.then(async () => {
          langs.set(g, await TS.Language.load(read ? await read(f) : wasmPath(f)));
        });
        loading.set(g, p);
      }
      return p;
    }),
  ).then(() => {});
}
/** A shell with no file paths it could hand to the wasm loader (JavaScriptCore): the bytes of each wasm file by name */
export type WasmReader = (file: string) => Promise<Uint8Array>;

// C / C++ / CUDA 都用 tree-sitter-cuda：C++ 语法加上 <<<>>>、__global__、__launch_bounds__ 等，节点名和 C++ 一样
const WASM: [Grammar, string][] = [
  ["python", "tree-sitter-python.wasm"],
  ["cpp", "tree-sitter-cuda.wasm"],
  ["rust", "tree-sitter-rust.wasm"],
];
const PKG: Record<string, string> = { "tree-sitter-cuda.wasm": "@yhnocoder/tree-sitter-cuda" };

function wasmPath(f: string) {
  if (wasmDir) return join(wasmDir, f);
  // vitest / node：从包里找（esbuild 打成 cjs 的脚本里 import.meta 是空的，用 require.resolve）
  const spec = `${PKG[f] ?? "@vscode/tree-sitter-wasm/wasm"}/${f}`;
  return (import.meta.resolve?.(spec) ?? require.resolve(spec)).replace(/^file:\/\//, "");
}
const join = (a: string, b: string) => (a.endsWith("/") ? a + b : `${a}/${b}`);

export const languageOf = (g: Grammar): TSLanguage | undefined => langs.get(g);

const parsers = new Map<Grammar, TSParser>();
function parser(g: Grammar) {
  let p = parsers.get(g);
  if (!p) {
    const l = langs.get(g);
    if (!l) throw new Error("initAnalysis() not awaited");
    p = new TS.Parser();
    p.setLanguage(l);
    parsers.set(g, p);
  }
  return p;
}

const queries = new Map<string, Query>();
export function query(g: Grammar, name: string, src: string): Query {
  const k = `${g}\0${name}`;
  let q = queries.get(k);
  if (!q) queries.set(k, (q = new TS.Query(langs.get(g)!, src)));
  return q;
}

/** 两段文本的差别 → 一次 tree-sitter 编辑（公共前缀 / 后缀之外的部分，下标是 UTF-16） */
export function diffEdit(a: string, b: string): Edit {
  const n = Math.min(a.length, b.length);
  let s = 0;
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < n - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  // 不从代理对中间切开
  if (s > 0 && isHigh(a.charCodeAt(s - 1))) s--;
  if (e > 0 && isLow(a.charCodeAt(a.length - e))) e--;
  return {
    startIndex: s,
    oldEndIndex: a.length - e,
    newEndIndex: b.length - e,
    startPosition: pointAt(a, s),
    oldEndPosition: pointAt(a, a.length - e),
    newEndPosition: pointAt(b, b.length - e),
  };
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff,
  isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
function pointAt(t: string, i: number) {
  let row = 0,
    ls = 0;
  for (let k = t.indexOf("\n"); k !== -1 && k < i; k = t.indexOf("\n", k + 1)) {
    row++;
    ls = k + 1;
  }
  return { row, column: i - ls };
}

/** 编辑能不能把 a 变成 b（只核对长度和前后没动的部分） */
function fits(a: string, b: string, e: Edit) {
  return (
    e.startIndex <= e.oldEndIndex &&
    e.oldEndIndex <= a.length &&
    e.startIndex <= e.newEndIndex &&
    e.newEndIndex <= b.length &&
    a.length - e.oldEndIndex === b.length - e.newEndIndex &&
    a.slice(0, e.startIndex) === b.slice(0, e.startIndex) &&
    a.slice(e.oldEndIndex) === b.slice(e.newEndIndex)
  );
}

type Entry = { g: Grammar; text: string; tree: Tree };

/**
 * The trees kept between parses of the same key (usually a file path), least recently used first out. Keyed by path, not by
 * content, so each host keeps its own: one host's files must not evict or forget another's.
 */
export class TreeCache {
  private trees = new Map<string, Entry>();

  /** max = how many trees to keep (each takes a few times the source's memory) */
  constructor(readonly max = 16) {}

  /**
   * The tree of text, kept under key: parsed incrementally when the key's last text differs (by edit, or by the common prefix
   * and suffix when edit is missing or does not fit). The cache owns it: the caller must not delete it.
   */
  tree(g: Grammar, text: string, key: string, edit?: Edit): Tree {
    const old = this.trees.get(key);
    let tree: Tree;
    if (old && old.g === g) {
      this.trees.delete(key);
      if (old.text === text) tree = old.tree;
      else {
        old.tree.edit(edit && fits(old.text, text, edit) ? edit : diffEdit(old.text, text));
        tree = parser(g).parse(text, old.tree)!;
        old.tree.delete();
      }
    } else {
      if (old) {
        old.tree.delete();
        this.trees.delete(key);
      }
      tree = parser(g).parse(text)!;
    }
    this.trees.set(key, { g, text, tree });
    while (this.trees.size > this.max) this.drop(this.trees.keys().next().value!);
    return tree;
  }

  /** Let go of key's tree, or of all of them */
  forget(key?: string) {
    for (const k of [...this.trees.keys()]) if (key === undefined || k === key) this.drop(k);
  }

  keys = () => [...this.trees.keys()];

  dispose() {
    this.forget();
  }

  private drop(k: string) {
    this.trees.get(k)!.tree.delete();
    this.trees.delete(k);
  }
}

/** Where a parse keeps its tree: the cache, the key, and optionally the edit from the key's last text to this one */
export type TreeAt = { cache: TreeCache; key: string; edit?: Edit };

/** A tree of text: kept in at's cache (owned = false, do not delete), or, without at, the caller's to delete (owned = true) */
export function treeOf(g: Grammar, text: string, at?: TreeAt): { tree: Tree; owned: boolean } {
  if (!at || at.cache.max === 0) return { tree: parser(g).parse(text)!, owned: true };
  return { tree: at.cache.tree(g, text, at.key, at.edit), owned: false };
}
