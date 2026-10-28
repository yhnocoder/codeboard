import katex from "katex";
import { mathMacros } from "./math";

// 网页上 KaTeX / MathJax 排好的公式按纯文字复制出来是"显示的字 + TeX 原文"（N×NN\times N）：MathML 里的字和 annotation 连在一起。
// 认法：从一个 TeX 记号（\ ^ _）往两边找 TeX 的范围，让 KaTeX 排一遍，前面紧挨着的字正好是排出来的字才算，留下 TeX
const TEX_CH = /[A-Za-z0-9{}()[\]+\-=*/.,:;'!|<>^_\\ &]/;
const ANCHOR = /\\[A-Za-z]+|\\[{}|,;!]|[\^_]/g;
const INVISIBLE = /[\s⁡-⁤​]/;
// 粘贴一整篇 TeX 源码时每个 \\ 都要试：KaTeX 排一次约 0.1 ms，一次粘贴最多排这么多次
const MAX_RENDERS = 1500;
const shown = new Map<string, string | null>();
function shownText(tex: string): string | null {
  let s = shown.get(tex);
  if (s === undefined) {
    try {
      const html = katex.renderToString(tex, { output: "mathml", throwOnError: true, macros: mathMacros() });
      s = html.replace(/<annotation[\s\S]*?<\/annotation>/, "").replace(/<[^>]+>/g, "")
        .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot);/gi, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" ? e.slice(2) : e.slice(1), e[1] === "x" ? 16 : 10)) : ({ amp: "&", lt: "<", gt: ">", quot: '"' } as Record<string, string>)[e.toLowerCase()]))
        .replace(new RegExp(INVISIBLE.source, "g"), "");
    } catch { s = null; }
    if (shown.size > 500) shown.clear();
    shown.set(tex, s);
  }
  return s;
}
/** 显示的字 r 是否正好在 t[..end) 的末尾（不管空白和不可见的字），是的话返回它开始的位置 */
function endsWith(t: string, end: number, r: string): number {
  let i = end, j = r.length;
  while (j > 0) {
    while (i > 0 && INVISIBLE.test(t[i - 1])) i--;
    if (i === 0 || t[i - 1] !== r[j - 1]) return -1;
    i--; j--;
  }
  return i;
}
/** 纯文字里"显示的字 + TeX"连着的公式换成 $TeX$；没有的原样返回 */
export function undoubleTex(t: string): string {
  let out = "", last = 0, budget = MAX_RENDERS;
  for (const m of t.matchAll(ANCHOR)) {
    const a = m.index!;
    if (a < last) continue;
    let lo = a, hi = a + m[0].length;
    while (lo > last && TEX_CH.test(t[lo - 1]) && a - lo < 40) lo--;
    while (hi < t.length && TEX_CH.test(t[hi]) && hi - a < 80) hi++;
    let hit: [number, number, number] | null = null;
    for (let e = hi; e > a && !hit && budget > 0; e--) {
      // TeX 只在词边上结束（后面是空格、别的字或到头），不然 "N\times N pixels" 要一个字一个字地试
      if (t[e - 1] === " " || (e < t.length && t[e] !== " " && TEX_CH.test(t[e])) || !balanced(t.slice(a, e))) continue;
      for (let s = lo; s <= a && budget > 0; s++) {
        if (t[s] === " ") continue;
        budget--;
        const tex = t.slice(s, e), r = shownText(tex);
        const from = r ? endsWith(t, s, r) : -1;
        if (from >= last) { hit = [from, s, e]; break; }
      }
    }
    if (!hit) continue;
    const [from, s, e] = hit;
    out += `${t.slice(last, from)}$${t.slice(s, e)}$`;
    last = e;
  }
  return last ? out + t.slice(last) : t;
}
function balanced(s: string): boolean {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "{") d++;
    else if (s[i] === "}" && --d < 0) return false;
  }
  return d === 0;
}
