// 小号 Markdown：标题、列表、引用、代码块、粗体 / 斜体 / 行内代码 / 链接，$…$ 和 $$…$$ 公式（KaTeX）。
// 只给 Note、Text、卡片说明、Text sidenote 用，不追求完整。markdown-it 的 zero 预设 + 下面自己的块规则和行内规则，
// 输出和 v0.1.5 的正则版一致：一行一块（不合并段落、不嵌套列表），空行 div.sp，不认 HTML / 转义 / 实体 / _强调_。
// 强调不用 CommonMark 的左右侧规则（"**注意：**后面" 在 CommonMark 里不算粗体），照旧版的顺序找配对。
import MarkdownIt from "markdown-it";
import type { StateBlock, StateCore, StateInline, Token } from "markdown-it";
import katex from "katex";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function tex(src: string, block: boolean) {
  try { return katex.renderToString(src, { displayMode: block, throwOnError: false, output: "html" }); }
  catch { return `<code>${esc(src)}</code>`; }
}

const it = MarkdownIt("zero");

// ---- 块：一行一块（代码块 / 公式块看到结束行）
const FENCE = /^```/, MATH = /^\s*\$\$\s*$/, H = /^(#{1,3})\s+(.*)$/, UL = /^\s*[-*]\s+(.*)$/, OL = /^\s*\d+[.)]\s+(.*)$/, QUOTE = /^>\s?(.*)$/;
const lineAt = (s: StateBlock, l: number) => s.src.slice(s.bMarks[l], s.eMarks[l]);
function put(s: StateBlock, type: string, tag: string, nesting: -1 | 0 | 1, map?: [number, number]) {
  const t = s.push(type, tag, nesting);
  t.block = false; // 块之间不插换行
  if (map) t.map = map;
  return t;
}
function wrap(s: StateBlock, type: string, tag: string, content: string, l: number) {
  put(s, type + "_open", tag, 1, [l, l + 1]);
  const t = put(s, "inline", "", 0, [l, l + 1]);
  t.content = content; t.children = [];
  put(s, type + "_close", tag, -1);
}
/** 代码块 / 公式块：到结束行为止；没有结束行就吃到全文末尾（连同最后的换行） */
function fenced(s: StateBlock, l: number, endLine: number, re: RegExp, type: string) {
  let i = l + 1;
  while (i < endLine && !re.test(lineAt(s, i))) i++;
  const open = i >= endLine;
  put(s, type, "", 0, [l, open ? Infinity : i + 1]).content = s.src.slice(s.bMarks[l + 1], open ? s.src.length : s.bMarks[i] - 1);
  s.line = open ? endLine : i + 1;
  return true;
}
it.block.ruler.at("paragraph", (s, l, endLine, silent) => {
  if (silent) return false;
  const line = lineAt(s, l);
  let m: RegExpMatchArray | null;
  if (FENCE.test(line)) return fenced(s, l, endLine, FENCE, "cb_code");
  if (MATH.test(line)) return fenced(s, l, endLine, MATH, "cb_math_block");
  if ((m = line.match(H))) wrap(s, "heading", "h" + m[1].length, m[2], l);
  else if (UL.test(line) || OL.test(line)) {
    // 相邻的同类条目并成一个列表；缩进不算嵌套
    const re = UL.test(line) ? UL : OL, tag = re === UL ? "ul" : "ol", from = l;
    const open = put(s, tag === "ul" ? "bullet_list_open" : "ordered_list_open", tag, 1);
    for (; l < endLine && (m = lineAt(s, l).match(re)); l++) wrap(s, "list_item", "li", m[1], l);
    open.map = [from, l];
    put(s, tag === "ul" ? "bullet_list_close" : "ordered_list_close", tag, -1);
    s.line = l;
    return true;
  }
  else if ((m = line.match(QUOTE))) wrap(s, "blockquote", "blockquote", m[1], l);
  else if (!line.trim()) put(s, "cb_sp", "", 0, [l, l + 1]); // 全角空格之类 markdown-it 不当空行
  else wrap(s, "paragraph", "p", line, l);
  s.line = l + 1;
  return true;
});
// markdown-it 跳过空行（包括末尾换行后的那一行），按行号补成 div.sp
it.core.ruler.after("block", "cb_sp", (s: StateCore) => {
  if (s.inlineMode) return;
  const out: Token[] = [];
  let next = 0;
  const sp = () => out.push(new s.Token("cb_sp", "", 0));
  for (const t of s.tokens) {
    if (t.map && t.level === 0 && t.nesting >= 0) { for (; next < t.map[0]; next++) sp(); next = t.map[1]; }
    out.push(t);
  }
  for (const n = s.src.split("\n").length; next < n; next++) sp();
  s.tokens = out;
});

// ---- 行内：先按旧版的顺序用正则找出各段（代码、公式、链接、裸网址、粗体、斜体），再按位置出 token。
// 找过的段在副本里换成占位符，后面的正则看不到里面的 * $ 等
type Span = { end: number; kind: "code" | "math" | "link" | "url" | "b" | "i"; from?: number; to?: number; text?: string; display?: boolean };
const HOLD = "\u0002";
function scan(src: string): Map<number, Span> {
  const spans = new Map<number, Span>();
  if (!/[`$*[]|https?:\/\//.test(src)) return spans; // 纯文字，大多数行
  let m = src;
  const hold = (a: number, b: number) => { m = m.slice(0, a) + HOLD.repeat(b - a) + m.slice(b); };
  const each = (re: RegExp, f: (x: RegExpExecArray) => void) => { for (const x of [...m.matchAll(re)]) f(x); };
  each(/`([^`]+)`/g, (x) => { spans.set(x.index, { end: x.index + x[0].length, kind: "code", text: x[1] }); hold(x.index, x.index + x[0].length); });
  each(/\$\$([^$]+)\$\$/g, (x) => { spans.set(x.index, { end: x.index + x[0].length, kind: "math", display: true, text: src.substr(x.index + 2, x[1].length) }); hold(x.index, x.index + x[0].length); });
  // 行内公式照 Pandoc：$ 后紧跟非空白，结尾 $ 前是非空白、后面不是数字。所以 "$5 and $10" 不算公式
  each(/(^|[^\\$])\$([^$\s](?:[^$]*[^$\s])?)\$(?!\d)/g, (x) => {
    const a = x.index + x[1].length, b = a + x[2].length + 2;
    spans.set(a, { end: b, kind: "math", text: src.slice(a + 1, b - 1) }); hold(a, b);
  });
  each(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (x) => {
    const a = x.index, la = a + 1, lb = la + x[1].length, b = a + x[0].length;
    spans.set(a, { end: b, kind: "link", from: la, to: lb, text: src.slice(lb + 2, b - 1) }); hold(a, la); hold(lb, b);
  });
  each(/(^|[\s(])(https?:\/\/[^\s)\u0002]+)/g, (x) => {
    const a = x.index + x[1].length, b = a + x[2].length;
    if (![...spans.values()].some((s) => s.kind === "link" && s.from! <= a && a < s.to!)) spans.set(a, { end: b, kind: "url", text: src.slice(a, b) }); // 链接文字里不再套
    hold(a, b);
  });
  each(/\*\*([^*]+)\*\*/g, (x) => { const a = x.index, b = a + x[0].length; spans.set(a, { end: b, kind: "b", from: a + 2, to: b - 2 }); hold(a, a + 2); hold(b - 2, b); });
  each(/(^|[^*])\*([^*\s][^*]*)\*/g, (x) => { const a = x.index + x[1].length, b = a + x[2].length + 2; spans.set(a, { end: b, kind: "i", from: a + 1, to: b - 1 }); });
  return spans;
}
const scans = new WeakMap<StateInline, { spans: Map<number, Span>; starts: number[] }>();
const spansOf = (s: StateInline) => {
  let r = scans.get(s);
  if (!r) { const spans = scan(s.src); scans.set(s, r = { spans, starts: [...spans.keys()].sort((a, b) => a - b) }); }
  return r;
};
function inner(s: StateInline, from: number, to: number) {
  const max = s.posMax;
  s.pos = from; s.posMax = to;
  s.md.inline.tokenize(s);
  s.posMax = max;
}
// 普通文字：一直到下一段的开头（cb_span 没接住的段头也当普通字符）
it.inline.ruler.at("text", (s, silent) => {
  const p = Math.min(spansOf(s).starts.find((a) => a > s.pos) ?? s.posMax, s.posMax);
  if (!silent) s.pending += s.src.slice(s.pos, p);
  s.pos = p;
  return true;
});
it.inline.ruler.before("text", "cb_span", (s, silent) => {
  const sp = spansOf(s).spans.get(s.pos);
  if (!sp || sp.end > s.posMax) return false; // 跨出外层（比如强调只盖住半个链接）就当普通字符
  if (!silent) {
    const end = sp.end;
    switch (sp.kind) {
      case "code": s.push("code_inline", "code", 0).content = sp.text!; break;
      case "math": { const t = s.push("cb_math", "", 0); t.content = sp.text!; t.info = sp.display ? "display" : ""; break; }
      case "url": s.push("link_open", "a", 1).attrs = [["class", "lnk"], ["data-href", sp.text!]]; s.push("text", "", 0).content = sp.text!; s.push("link_close", "a", -1); break;
      case "link": s.push("link_open", "a", 1).attrs = [["class", "lnk"], ["data-href", sp.text!]]; inner(s, sp.from!, sp.to!); s.push("link_close", "a", -1); break;
      default: { const tag = sp.kind; s.push(tag === "b" ? "strong_open" : "em_open", tag, 1); inner(s, sp.from!, sp.to!); s.push(tag === "b" ? "strong_close" : "em_close", tag, -1); }
    }
    s.pos = end;
  } else s.pos = sp.end;
  return true;
});

const r = it.renderer.rules;
r.cb_code = (ts, i) => `<pre><code>${esc(ts[i].content)}</code></pre>`;
r.cb_math = (ts, i) => tex(ts[i].content, ts[i].info === "display");
r.cb_math_block = (ts, i) => `<div class="math">${tex(ts[i].content, true)}</div>`;
r.cb_sp = () => `<div class="sp"></div>`;

/** 行内（一行文字） */
export const inline = (s: string): string => it.renderInline(s);
export const md = (src: string): string => it.render(src);
