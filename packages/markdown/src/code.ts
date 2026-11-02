// 着色还没回来时先放纯文字：同样的字，回来后只换颜色，不跳
import { capped } from "./cache";

/** 文字 + 语言（换成了正式 id，见 langId）→ 着好色的 HTML（只有 span 和转义的字，每行之间一个 \n）；不会着色给 null */
export type CodeHighlighter = (text: string, lang: string) => Promise<string | null>;

const MAX = 500;

/** One Markdown instance's code highlighting: the caller's highlighter and what it answered */
export class Highlighter {
  private done = new Map<string, string>();
  private flying = new Map<string, Promise<string | null>>();
  private colored = new WeakSet<HTMLElement>();
  /** langId：语言名 → 正式 id（py 和 python 是同一份缓存、问的是同一个名字）；不给就照原样 */
  constructor(
    private ask?: CodeHighlighter,
    private langId: (lang: string) => string = (lang) => lang,
  ) {}
  private keyOf = (text: string, lang: string) => `${this.langId(lang)}\n${text}`;

  /** 已经着好色的 HTML；没有就 undefined（不问） */
  cached = (text: string, lang: string) => this.done.get(this.keyOf(text, lang));

  /** 着好色的 HTML（每行之间一个 \n）；没有着色、没写语言时给 null */
  highlight(text: string, lang: string): Promise<string | null> {
    const k = this.keyOf(text, lang);
    const hit = this.done.get(k);
    if (hit !== undefined) return Promise.resolve(hit);
    if (!this.ask || !lang) return Promise.resolve(null);
    let p = this.flying.get(k);
    if (!p) {
      p = this.ask(text, this.langId(lang))
        .catch(() => null)
        .then((h) => {
          this.flying.delete(k);
          if (h !== null) capped(this.done, MAX, k, h);
          return h;
        });
      this.flying.set(k, p);
    }
    return p;
  }

  /** 静态显示挂上以后：el 里还没上色的代码块上色（缓存里有的马上换，没有的等着色回来） */
  color(el: HTMLElement) {
    for (const code of el.querySelectorAll<HTMLElement>("pre.md-code[data-lang] > code")) {
      if (this.colored.has(code)) continue;
      this.colored.add(code);
      const lang = code.parentElement!.dataset.lang!,
        text = code.textContent ?? "";
      const put = (h: string | null) => {
        if (h !== null && code.textContent === text) code.innerHTML = h;
      };
      const hit = this.cached(text, lang);
      if (hit !== undefined) put(hit);
      else void this.highlight(text, lang).then(put);
    }
  }
}
