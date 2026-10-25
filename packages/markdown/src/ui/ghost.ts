// 灰字补全的规则（和编辑器无关）：Note（editor/ghost.ts，ProseMirror）和代码（cm/ghost.ts，CodeMirror）各一层薄的接上。
// 停笔一会儿后问宿主要续写，问的时候又动过就作废；打的字正好是灰字开头只吃掉那几个字；Tab 全收、⌘→ 收一个词、Esc 清掉
export type Ghost = { text: string; pos: number } | null;
export type Complete = (before: string, after: string) => Promise<string | null>;

const DELAY = 700;
const NEXT = /[\s.,;:!?)\]}，。；：！？）]/;

/** 什么时候问：光标后面是行尾、空白或收尾的标点（行中也补，像 Copilot），这一行至少 3 个字 */
export const wantGhost = (line: string, at: number) => {
  const next = line.charAt(at);
  return (!next || NEXT.test(next)) && line.trim().length >= 3;
};

/** 在灰字的位置打了 typed、光标到了 at：打的正好是灰字开头就留下剩下的，不然清掉 */
export function eatGhost(g: NonNullable<Ghost>, typed: string, at: number): Ghost {
  if (!typed || !g.text.startsWith(typed)) return null;
  const rest = g.text.slice(typed.length);
  return rest ? { text: rest, pos: at } : null;
}

/** ⌘→ 收下的那一个词 */
export const nextWord = (text: string) => /^\s*[^\s]+/.exec(text)?.[0] ?? text;

/** 一次问：编辑器的适配层给 */
export type GhostQuery = {
  /** 光标前后的原文（到点了才算：Note 要序列化整篇） */
  context(): [string, string];
  /** 回答回来时还算不算数（文档、光标没动过） */
  still(): boolean;
  show(text: string): void;
};

// 用的一方说「先别补」（白板上拖卡、改卡的大小时）：显示着的灰字都清掉，排着的问作废，放开前不再问
let held = false;
const askers = new Set<GhostAsker>();
/** on = 先别补：每个编辑器的灰字清掉、排着的问作废；off = 照常（不补问，下次打字时再问） */
export function holdGhosts(on: boolean) {
  held = on;
  if (on) for (const a of askers) a.drop();
}

/** 防抖地问：probe 现在能问就给一次问（不能就 null），排上时和到点时各看一次。clear 清掉这个编辑器显示着的灰字 */
export class GhostAsker {
  private timer: number | undefined;
  private n = 0;
  constructor(private complete: Complete, private clear: () => void, private delay = DELAY) { askers.add(this); }
  schedule(probe: () => GhostQuery | null) {
    this.cancel();
    const id = this.n;
    if (held || !probe()) return;
    this.timer = window.setTimeout(async () => {
      const q = held ? null : probe();
      if (id !== this.n || !q) return;
      const [before, after] = q.context();
      const text = await this.complete(before, after).catch(() => null);
      if (id === this.n && !held && text && q.still()) q.show(text);
    }, this.delay);
  }
  cancel() { clearTimeout(this.timer); this.n++; }
  /** 作废排着的问，清掉显示着的灰字 */
  drop() { this.cancel(); this.clear(); }
  /** 编辑器拆掉时 */
  dispose() { this.cancel(); askers.delete(this); }
}
