// tree-sitter 分析的缓存：同一份内容只分析一次。
import { fingerprint } from "@codeboard/core";
import { analyze, initAnalysis, type FileAnalysis } from "@codeboard/core/analysis";
import { Lru } from "./ws";

let ready = false;
export async function startAnalysis(dir: string) {
  try {
    await initAnalysis(dir);
    ready = true;
  } catch (e) {
    console.error("[codeboard] tree-sitter init failed", e);
  }
}
export const analysisReady = () => ready;

const cache = new Lru<FileAnalysis>(80);

/** 分析一份文本（按语言 + 内容指纹缓存）；tree-sitter 没准备好时只有空行标记 */
export function analysisOf(lang: string, text: string): FileAnalysis {
  const k = `${lang}\0${text.length}\0${fingerprint(text)}`;
  let a = cache.get(k);
  if (!a) {
    a = analyze(lang, text);
    if (ready) cache.set(k, a);
  }
  return a;
}
