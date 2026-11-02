// 「转到定义」「转到实现」的结果缓存：悬停预取、打开白板的预热、点调用展开、peek 共用同一个请求（语言服务冷的时候一次要 ~1 s）。
// 键 = 文件 + 位置 + 文件内容指纹；任何文件改动（编辑、新建、删除）整个清掉（实现在别的文件里，也跟着清），另外最多留 60 s。
import { fingerprint } from "@codeboard/core";
import type { HostContext } from "./context";
import { Lru } from "./ws";

export type Def = { abs: string; line: number; col: number };

const TTL = 60_000;

export class DefCache {
  private cache = new Lru<{ p: Promise<Def[]>; at: number }>(300);
  private gen = 0;

  constructor(private cx: HostContext) {}

  forget() {
    this.gen++;
    this.cache.clear();
  }

  /**
   * 这个文件、这个位置的定义：缓存里有（含正在问的）就用；没结果的不留（语言服务还在启动时会先回空）。
   * kind = "impl"：转到实现（问的是已经找到的定义处，语言服务已经在答话：没有覆盖的空结果也留着）
   */
  async shared(
    abs: string,
    line: number,
    col: number,
    ask: () => Promise<Def[]>,
    kind: "def" | "impl" = "def",
  ): Promise<Def[]> {
    const text = await this.cx.readText(abs);
    if (text === null) return ask();
    const k = `${kind}\0${abs}\0${line}\0${col}\0${text.length}\0${fingerprint(text)}`;
    const keepEmpty = kind === "impl";
    const g = this.gen;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < TTL) {
      const r = await hit.p;
      if ((r.length || keepEmpty) && g === this.gen) return r;
    }
    const p = ask();
    this.cache.set(k, { p, at: Date.now() });
    const r = await p;
    if (((!r.length && !keepEmpty) || g !== this.gen) && this.cache.get(k)?.p === p) this.cache.delete(k);
    return g === this.gen ? r : ask(); // 问的时候文件改了：重新问
  }
}
