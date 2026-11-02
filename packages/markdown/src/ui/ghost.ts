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

/** Holding AI completions on a page: while held (a drag, a resize) every editor that shares it clears its grey text and drops
 *  a pending ask, and asks nothing until released; released, it asks again on the next keystroke */
export type GhostHold = { hold(on: boolean): void };
type Hold = GhostHold & { held: boolean; askers: Set<GhostAsker> };

export function createGhostHold(): GhostHold {
  const h: Hold = {
    held: false,
    askers: new Set(),
    hold(on) {
      h.held = on;
      if (on) for (const a of h.askers) a.drop();
    },
  };
  return h;
}

/** 防抖地问：probe 能问时给一次问（不能就 null），排上时和到点时各看一次 */
export class GhostAsker {
  private timer: number | undefined;
  private n = 0;
  private hold: Hold;
  /** hold: the page's (createGhostHold); without one this asker is never held */
  constructor(
    private complete: Complete,
    private clear: () => void,
    hold: GhostHold = createGhostHold(),
    private delay = DELAY,
  ) {
    this.hold = hold as Hold;
    this.hold.askers.add(this);
  }
  schedule(probe: () => GhostQuery | null) {
    this.cancel();
    const id = this.n;
    if (this.hold.held || !probe()) return;
    this.timer = window.setTimeout(async () => {
      const q = this.hold.held ? null : probe();
      if (id !== this.n || !q) return;
      const [before, after] = q.context();
      const text = await this.complete(before, after).catch(() => null);
      if (id === this.n && !this.hold.held && text && q.still()) q.show(text);
    }, this.delay);
  }
  cancel() {
    clearTimeout(this.timer);
    this.n++;
  }
  drop() {
    this.cancel();
    this.clear();
  }
  dispose() {
    this.cancel();
    this.hold.askers.delete(this);
  }
}
