import { createHighlighterCore, createCssVariablesTheme, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import python from "shiki/langs/python.mjs";
import cpp from "shiki/langs/cpp.mjs";
import c from "shiki/langs/c.mjs";
import { findCalls, type CallSpan } from "@codeboard/core";

// 颜色用 CSS 变量输出，由 webview 按亮色/暗色主题决定
const theme = createCssVariablesTheme({ name: "codeboard", variablePrefix: "--shiki-", fontStyle: true });

let hl: Promise<HighlighterCore> | undefined;
const highlighter = () =>
  (hl ??= createHighlighterCore({ themes: [theme], langs: [python, cpp, c], engine: createJavaScriptRegexEngine({ forgiving: true }) }));

/** VS Code languageId → shiki 语言；Triton、TileLang 都是 Python 写的 */
function shikiLang(lang: string): string | null {
  if (lang === "python") return "python";
  if (/^(cpp|cuda-cpp|cuda|objective-cpp)$/.test(lang)) return "cpp";
  if (lang === "c") return "c";
  return null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Tok = { text: string; style: string };

/** 一段代码逐行生成高亮 HTML；看起来像调用的地方包成可点击的 .xref */
export async function render(lines: string[], lang: string, start: number): Promise<{ html: string[]; calls: CallSpan[] }> {
  const sl = shikiLang(lang);
  let toks: Tok[][];
  if (sl) {
    const h = await highlighter();
    const res = h.codeToTokens(lines.join("\n"), { lang: sl, theme: "codeboard" });
    toks = res.tokens.map((line) =>
      line.map((t) => {
        let style = t.color ? `color:${t.color}` : "";
        if (t.fontStyle && t.fontStyle & 1) style += ";font-style:italic";
        if (t.fontStyle && t.fontStyle & 2) style += ";font-weight:600";
        return { text: t.content, style };
      }),
    );
  } else toks = lines.map((l) => [{ text: l, style: "" }]);

  const calls: CallSpan[] = [];
  const html = lines.map((text, i) => {
    const line = start + i;
    const cs = findCalls(text);
    for (const k of cs) calls.push({ line, ...k });
    return wrap(toks[i] ?? [{ text, style: "" }], cs);
  });
  return { html, calls };
}

/** 把 token 列表按调用位置切开，调用名外面套一层 xref */
function wrap(toks: Tok[], cs: { start: number; end: number; name: string; recv?: string }[]): string {
  let out = "", col = 0;
  const callAt = (i: number) => cs.find((k) => k.start <= i && i < k.end);
  for (const t of toks) {
    let i = 0;
    while (i < t.text.length) {
      const abs = col + i;
      const k = callAt(abs);
      // 一直切到下一个边界：调用开始/结束或 token 结束
      let j = i + 1;
      while (j < t.text.length && callAt(col + j) === k) j++;
      const piece = esc(t.text.slice(i, j));
      const span = t.style ? `<span style="${t.style}">${piece}</span>` : piece;
      out += k
        ? `<span class="xref" data-call="${esc(k.name)}" data-recv="${esc(k.recv ?? "")}" data-col="${k.start}" title="展开 ${esc(k.name)}">${span}</span>`
        : span;
      i = j;
    }
    col += t.text.length;
  }
  return out;
}
