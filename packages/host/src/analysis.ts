import { fingerprint } from "@codeboard/core";
import { analyze, clipAnalysis, initAnalysis, type FileAnalysis, type TreeAt } from "@codeboard/analysis";
import type { HostContext } from "./context";
import { Lru } from "./ws";

let ready = false;
let settle!: () => void;
// Settles once startAnalysis has finished (or failed); work that needs the parsers may ask before it is called
const started = new Promise<void>((r) => (settle = r));
/** dir = 放全部 wasm 的目录（插件的 dist/）；Node 下不给，从 npm 包里找 */
export async function startAnalysis(dir?: string) {
  try {
    await initAnalysis(dir);
    ready = true;
  } catch (e) {
    console.error("[codeboard] tree-sitter init failed", e);
  }
  settle();
}
export const analysisReady = () => ready;
/** tree-sitter 准备好（或者失败了）之后 */
export const whenAnalysisReady = () => started;

const cache = new Lru<FileAnalysis>(80);
const segCache = new Lru<FileAnalysis>(200);
const keyOf = (lang: string, text: string) => `${lang}\0${text.length}\0${fingerprint(text)}`;

/** 已经分析过（还在缓存里）才返回，不会新做分析 */
export function cachedAnalysis(lang: string, text: string): FileAnalysis | undefined {
  const k = keyOf(lang, text);
  return cache.has(k) ? cache.get(k) : undefined;
}

/**
 * 分析一份文本（按语言 + 内容指纹缓存）；tree-sitter 没准备好时只有空行标记。
 * tree = 文本来自哪个文件（treeAt）：留着这个文件的语法树，文件改了再分析时增量解析
 */
export function analysisOf(lang: string, text: string, tree?: TreeAt): FileAnalysis {
  const k = keyOf(lang, text);
  let a = cache.get(k);
  if (!a) {
    a = analyze(lang, text, { tree });
    if (ready) cache.set(k, a);
  }
  return a;
}

/**
 * 只要 start..end 这几行（卡片的段）：calls、注释 / docstring 标记只算这几行，symbols 只有和这几行相交的，imports 是整个文件的。
 * 整个文件分析过就直接裁剪；否则只查这几行（同一个文件的语法树留着，同一文件的多张卡只解析一次）
 */
export function segAnalysis(lang: string, text: string, start: number, end: number, tree?: TreeAt): FileAnalysis {
  const k = keyOf(lang, text);
  const full = cache.has(k) ? cache.get(k) : undefined;
  if (full) return clipAnalysis(full, start, end);
  const sk = `${k}\0${start}\0${end}`;
  let a = segCache.get(sk);
  if (!a) {
    a = analyze(lang, text, { tree, lines: { start, end } });
    if (ready) segCache.set(sk, a);
  }
  return a;
}

/** 只要符号（名字索引用）：缓存里有就用，没有就分析但不放进缓存（建索引时几千个文件别把常用的挤出去） */
export function symbolsOf(lang: string, text: string) {
  return (cachedAnalysis(lang, text) ?? analyze(lang, text)).symbols;
}

/** Where the analysis keeps this host's tree of file; none without a file */
export const treeAt = (cx: HostContext, file: string | null | undefined): TreeAt | undefined =>
  file ? { cache: cx.trees, key: file } : undefined;
