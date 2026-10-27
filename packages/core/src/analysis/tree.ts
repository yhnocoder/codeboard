// 带 key（通常是文件路径）解析时留着上次的树：文本变了就 tree.edit + 增量解析，没变就直接复用。
import TS from "@vscode/tree-sitter-wasm";
import type { Parser as TSParser, Language as TSLanguage, Tree, Edit, Query } from "@vscode/tree-sitter-wasm";

import type { Grammar } from "../langs";
export type { Edit, Grammar };

let ready: Promise<void> | undefined;
const langs = new Map<Grammar, TSLanguage>();
let wasmDir: string | undefined;

/**
 * 宿主启动时调用一次；dir = 放全部 wasm 的目录（插件的 dist/）。
 * Node 下不给：运行时和 Python / Rust 语法用 @vscode/tree-sitter-wasm 里的，C / C++ / CUDA 用 @yhnocoder/tree-sitter-cuda 里的
 */
export function initAnalysis(dir?: string): Promise<void> {
  if (dir) wasmDir = dir;
  return (ready ??= (async () => {
    await TS.Parser.init({ locateFile: (f: string) => wasmPath(f) });
    for (const [g, f] of WASM) langs.set(g, await TS.Language.load(wasmPath(f)));
  })());
}

// C / C++ / CUDA 都用 tree-sitter-cuda：C++ 语法加上 <<<>>>、__global__、__launch_bounds__ 等，节点名和 C++ 一样
const WASM: [Grammar, string][] = [["python", "tree-sitter-python.wasm"], ["cpp", "tree-sitter-cuda.wasm"], ["rust", "tree-sitter-rust.wasm"]];
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

type Entry = { g: Grammar; text: string; tree: Tree };
const trees = new Map<string, Entry>();
let maxTrees = 16;

/** 最多留多少棵树（每棵大约是源码的几倍内存） */
export function setTreeCacheSize(n: number) {
  maxTrees = Math.max(0, n);
  trim();
}
function trim() {
  while (trees.size > maxTrees) {
    const k = trees.keys().next().value!;
    trees.get(k)!.tree.delete();
    trees.delete(k);
  }
}
export function forgetTree(key?: string) {
  for (const [k, e] of trees) if (key === undefined || k === key) { e.tree.delete(); trees.delete(k); }
}
export const cachedTrees = () => [...trees.keys()];

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
  return { startIndex: s, oldEndIndex: a.length - e, newEndIndex: b.length - e, startPosition: pointAt(a, s), oldEndPosition: pointAt(a, a.length - e), newEndPosition: pointAt(b, b.length - e) };
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff, isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
function pointAt(t: string, i: number) {
  let row = 0, ls = 0;
  for (let k = t.indexOf("\n"); k !== -1 && k < i; k = t.indexOf("\n", k + 1)) { row++; ls = k + 1; }
  return { row, column: i - ls };
}

/** 编辑能不能把 a 变成 b（只核对长度和前后没动的部分） */
function fits(a: string, b: string, e: Edit) {
  return e.startIndex <= e.oldEndIndex && e.oldEndIndex <= a.length && e.startIndex <= e.newEndIndex && e.newEndIndex <= b.length
    && a.length - e.oldEndIndex === b.length - e.newEndIndex && a.slice(0, e.startIndex) === b.slice(0, e.startIndex) && a.slice(e.oldEndIndex) === b.slice(e.newEndIndex);
}

/**
 * 解析出一棵树。没有 key：用完由调用方 delete（owned = true）。
 * 有 key：树留在缓存里（owned = false，别 delete）；上次的文本和这次不同时增量解析，edit 不给就按前后缀算。
 */
export function treeOf(g: Grammar, text: string, key?: string, edit?: Edit): { tree: Tree; owned: boolean } {
  if (key === undefined || maxTrees === 0) return { tree: parser(g).parse(text)!, owned: true };
  const old = trees.get(key);
  let tree: Tree;
  if (old && old.g === g) {
    trees.delete(key);
    if (old.text === text) tree = old.tree;
    else {
      old.tree.edit(edit && fits(old.text, text, edit) ? edit : diffEdit(old.text, text));
      tree = parser(g).parse(text, old.tree)!;
      old.tree.delete();
    }
  } else {
    if (old) { old.tree.delete(); trees.delete(key); }
    tree = parser(g).parse(text)!;
  }
  trees.set(key, { g, text, tree });
  trim();
  return { tree, owned: false };
}
