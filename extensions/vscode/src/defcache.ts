// 「转到定义」的结果缓存：悬停预取、点调用展开、peek 共用同一个请求（语言服务冷的时候一次要 ~1 s）。
// 键 = 文件 + 位置 + 文件内容指纹；任何文件改动（编辑、新建、删除）整个清掉，另外最多留 60 s。
import { fingerprint } from "@codeboard/core";
import { Lru, readText } from "./ws";

export type Def = { abs: string; line: number; col: number };

const TTL = 60_000;
const cache = new Lru<{ p: Promise<Def[]>; at: number }>(300);
let gen = 0;

/** 文件内容变了：之前问到的定义位置可能已经不对 */
export function forgetDefs() { gen++; cache.clear(); }

/** 这个文件、这个位置的定义：缓存里有（含正在问的）就用；没结果的不留（语言服务还在启动时会先回空） */
export async function sharedDefs(abs: string, line: number, col: number, ask: () => Promise<Def[]>): Promise<Def[]> {
  const text = await readText(abs);
  if (text === null) return ask();
  const k = `${abs}\0${line}\0${col}\0${text.length}\0${fingerprint(text)}`;
  const g = gen;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) {
    const r = await hit.p;
    if (r.length && g === gen) return r;
  }
  const p = ask();
  cache.set(k, { p, at: Date.now() });
  const r = await p;
  if ((!r.length || g !== gen) && cache.get(k)?.p === p) cache.delete(k);
  return g === gen ? r : ask(); // 问的时候文件改了：重新问
}

