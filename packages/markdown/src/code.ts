// 着色还没回来时先放纯文字：同样的字，回来后只换颜色，不跳

/** 文字 + 语言（换成了正式 id，见下面的 id）→ 着好色的 HTML（只有 span 和转义的字，每行之间一个 \n）；不会着色给 null */
export type CodeHighlighter = (text: string, lang: string) => Promise<string | null>;
let ask: CodeHighlighter | undefined;
let langId = (lang: string) => lang;
/** 接上着色。id：语言名 → 正式 id（py 和 python 是同一份缓存、问的是同一个名字）；不给就照原样 */
export const setCodeHighlighter = (f: CodeHighlighter, id?: (lang: string) => string) => {
  ask = f;
  if (id) langId = id;
};

const done = new Map<string, string>();
const flying = new Map<string, Promise<string | null>>();
const MAX = 500;
const keyOf = (text: string, lang: string) => `${langId(lang)}\n${text}`;

/** 已经着好色的 HTML；没有就 undefined（不问宿主） */
export const cachedCode = (text: string, lang: string) => done.get(keyOf(text, lang));

/** 着好色的 HTML（每行之间一个 \n）；没有宿主、没写语言时给 null */
export function highlightCode(text: string, lang: string): Promise<string | null> {
  const k = keyOf(text, lang);
  const hit = done.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  if (!ask || !lang) return Promise.resolve(null);
  let p = flying.get(k);
  if (!p) {
    p = ask(text, langId(lang))
      .catch(() => null)
      .then((h) => {
        flying.delete(k);
        if (h !== null) {
          if (done.size >= MAX) done.delete(done.keys().next().value!);
          done.set(k, h);
        }
        return h;
      });
    flying.set(k, p);
  }
  return p;
}

const colored = new WeakSet<HTMLElement>();
/** 静态显示挂上以后：el 里还没上色的代码块上色（缓存里有的马上换，没有的等宿主回来） */
export function colorCode(el: HTMLElement) {
  for (const code of el.querySelectorAll<HTMLElement>("pre.md-code[data-lang] > code")) {
    if (colored.has(code)) continue;
    colored.add(code);
    const lang = code.parentElement!.dataset.lang!,
      text = code.textContent ?? "";
    const put = (h: string | null) => {
      if (h !== null && code.textContent === text) code.innerHTML = h;
    };
    const hit = cachedCode(text, lang);
    if (hit !== undefined) put(hit);
    else void highlightCode(text, lang).then(put);
  }
}
