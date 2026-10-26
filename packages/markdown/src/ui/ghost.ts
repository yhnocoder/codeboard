export type Ghost = { text: string; pos: number } | null;
export type Complete = (before: string, after: string) => Promise<string | null>;

const DELAY = 700;
const NEXT = /[\s.,;:!?)\]}，。；：！？）]/;

export const wantGhost = (line: string, at: number) => {
  const next = line.charAt(at);
  return (!next || NEXT.test(next)) && line.trim().length >= 3;
};

export function eatGhost(g: NonNullable<Ghost>, typed: string, at: number): Ghost {
  if (!typed || !g.text.startsWith(typed)) return null;
  const rest = g.text.slice(typed.length);
  return rest ? { text: rest, pos: at } : null;
}

/** ⌘→ 收下的那一个词 */
export const nextWord = (text: string) => /^\s*[^\s]+/.exec(text)?.[0] ?? text;

export type GhostQuery = {
  /** 到点了才算（Note 要序列化整篇） */
  context(): [string, string];
  /** 回答回来时文档、光标没动过 */
  still(): boolean;
  show(text: string): void;
};

let held = false;
const askers = new Set<GhostAsker>();
/** on = 先别补（比如拖动、改大小时）：每个编辑器的灰字清掉、排着的问作废，放开前不再问；off = 照常（不补问，下次打字时再问） */
export function holdGhosts(on: boolean) {
  held = on;
  if (on) for (const a of askers) a.drop();
}

/** 防抖地问：probe 能问时给一次问（不能就 null），排上时和到点时各看一次 */
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
  drop() { this.cancel(); this.clear(); }
  dispose() { this.cancel(); askers.delete(this); }
}
