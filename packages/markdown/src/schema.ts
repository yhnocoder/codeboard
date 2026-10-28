// 编辑器和静态显示共用这一套 schema，所以编辑和显示长得一样。
// MarkdownManager 只建一个，用自己的 marked 实例（@tiptap/markdown 默认往全局 marked 上挂规则，建几个就叠几层，解析会越来越慢）。
import { Mark, Node, getSchema, mergeAttributes, markInputRule, markPasteRule, parseIndentedBlocks, InputRule, type AnyExtension, type JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Bold, { starPasteRegex } from "@tiptap/extension-bold";
import Italic, { underscoreInputRegex } from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import Link from "@tiptap/extension-link";
import CodeBlock from "@tiptap/extension-code-block";
import Underline from "@tiptap/extension-underline";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import CodeMark from "@tiptap/extension-code";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import { MarkdownManager } from "@tiptap/markdown";
import { Marked, Tokenizer } from "marked";
import { TaskList, TaskItem, ListItem, OrderedList } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Footnotes, Footnote, FootnoteReference } from "tiptap-footnotes";
import DOMPurify from "dompurify";
import katex from "katex";
import { EMOJI } from "./emoji";

// ---------- 公式：照 Pandoc 的规则 ----------
// 行内 $…$：$ 后紧跟非空白，结尾 $ 前是非空白、后面不是数字，所以 "$5 and $10" 不算公式；紧跟在 \ 或 $ 后面的 $ 不开头。
// 行内的 $$…$$ 是行内的大号公式
const INLINE_MATH = /^\$\$([^$]+?)\$\$|^\$([^$\s](?:[^$]*[^$\s\\])?)\$(?!\d)/;
/** 交给 KaTeX 排的 TeX：行内的 $$…$$ 留在行内（displayMode 关着），用 \displaystyle 排成大号的；原文不改 */
export const mathTex = (latex: string, display: boolean) => (display ? `\\displaystyle ${latex}` : latex);
const Math1 = InlineMath.extend({
  addAttributes() {
    return { ...this.parent?.(), display: { default: false, parseHTML: (e) => e.getAttribute("data-display") === "yes", renderHTML: (a) => (a.display ? { "data-display": "yes" } : {}) } };
  },
  // 和 TipTap 自带的一样，只是 $$…$$ 照 mathTex 排（自带的不认 display，排成小号的）
  addNodeView() {
    const { onClick } = this.options, editable = () => this.editor.isEditable;
    return ({ node, getPos }) => {
      const dom = document.createElement("span");
      dom.className = "tiptap-mathematics-render";
      if (editable()) dom.classList.add("tiptap-mathematics-render--editable");
      dom.dataset.type = "inline-math";
      dom.setAttribute("data-latex", node.attrs.latex);
      if (node.attrs.display) dom.dataset.display = "yes";
      try {
        katex.render(mathTex(node.attrs.latex, !!node.attrs.display), dom, { ...this.options.katexOptions, displayMode: false });
      } catch {
        dom.textContent = node.attrs.latex;
        dom.classList.add("inline-math-error");
      }
      const click = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        const pos = getPos();
        if (pos != null) onClick?.(node, pos);
      };
      if (onClick) dom.addEventListener("click", click);
      return { dom, destroy: () => dom.removeEventListener("click", click) };
    };
  },
  // 打字时由编辑器按这里的解析规则重解析（editor/typora.ts；TipTap 自带的把 $$x$$ 当行内小公式）
  addInputRules: () => [],
  parseMarkdown: (t) => ({ type: "inlineMath", attrs: { latex: t.latex, display: !!t.display } }),
  renderMarkdown: (n) => (n.attrs?.display ? `$$${n.attrs.latex}$$` : `$${n.attrs?.latex ?? ""}$`),
  markdownTokenizer: {
    name: "inlineMath", level: "inline",
    start: (src) => src.indexOf("$"),
    tokenize: (src, tokens) => {
      const prev = tokens[tokens.length - 1]?.raw;
      if (prev && /[\\$]$/.test(prev)) return;
      const m = INLINE_MATH.exec(src);
      if (!m) return;
      return { type: "inlineMath", raw: m[0], latex: (m[1] ?? m[2]).trim(), display: m[1] !== undefined };
    },
  },
});
// 块公式：$$ 单独起一行（或 $$…$$ 占满一行）
const BLOCK_MATH = /^ {0,3}\$\$([^$]+?)\$\$[ \t]*(?:\n|$)/;
/**
 * 块的 start：marked 拿它找一段字在哪断开，传的是 src.slice(1)，^ 会落在行中间（\[^1]: 的 \ 后面）。
 * 只认换行后面的那一处（re 以 \n 开头）；在行首的由 tokenize 直接认
 */
const lineStart = (re: RegExp) => (src: string) => { const m = re.exec(src); return m ? m.index + 1 : -1; };
/**
 * 有序列表交给 marked 自己的列表规则（CommonMark）：TipTap 另写的那套要求记号后面有字，空的 "2." 会被读成上一项的续行。
 * 关掉它要换成一个什么都不认的分词器（写 undefined 会取回父扩展的那个）；脚注列表是从有序列表扩展来的，也带着它
 */
const NO_OL_TOKENIZER = { name: "orderedList", level: "block" as const, start: () => -1, tokenize: () => undefined };
const Math2 = BlockMath.extend({
  addInputRules: () => [],
  renderMarkdown: (n) => `$$\n${n.attrs?.latex ?? ""}\n$$`,
  markdownTokenizer: {
    name: "blockMath", level: "block",
    start: lineStart(/\n {0,3}\$\$/),
    tokenize: (src) => {
      const m = BLOCK_MATH.exec(src);
      if (!m) return;
      return { type: "blockMath", raw: m[0], latex: m[1].trim() };
    },
  },
});

// ---------- 代码块 ----------
// isolating：编辑时代码块是一个自己管光标的代码编辑器（editor/codeblock.ts），对 ProseMirror 来说是封闭的块，
// 两个代码块之间、文档头尾的代码块外面才停得住光标（gapcursor 只认两边封闭的位置）
const Code = CodeBlock.extend({
  isolating: true,
  addAttributes() {
    return {
      language: {
        default: null, rendered: false,
        parseHTML: (e) => e.getAttribute("data-lang") ?? /\blanguage-(\S+)/.exec(e.firstElementChild?.className ?? "")?.[1] ?? null,
      },
    };
  },
  renderHTML: ({ node }) => ["pre", { class: "md-code", "data-lang": node.attrs.language || null }, ["code", 0]],
  renderMarkdown: (n, h) => {
    const body = n.content ? h.renderChildren(n.content) : "";
    const run = Math.max(2, ...[...body.matchAll(/^ {0,3}(`{3,})/gm)].map((m) => m[1].length));
    const f = "`".repeat(run + 1);
    return `${f}${n.attrs?.language ?? ""}\n${body}\n${f}`;
  },
}).configure({ defaultLanguage: null, enableTabIndentation: true });

// ---------- 折叠块：<details><summary>标题</summary> … </details>（GitHub 也认这个写法） ----------
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
function detailsAt(src: string) {
  // 找配对的 </details>（可以嵌套）
  const open = /^ {0,3}<details(\s+open)?\s*>[ \t]*\n?/i.exec(src);
  if (!open) return;
  const re = /<details(\s[^>]*)?>|<\/details\s*>/gi;
  re.lastIndex = open[0].length;
  let depth = 1, m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (!depth) {
      let end = m.index + m[0].length;
      const tail = /^[ \t]*(?:\n|$)/.exec(src.slice(end));
      if (!tail) return;
      end += tail[0].length;
      let inner = src.slice(open[0].length, m.index);
      const sm = /^\s*<summary>([\s\S]*?)<\/summary>[ \t]*\n?/i.exec(inner);
      const summary = sm ? unHtml(sm[1].trim()) : "Details";
      if (sm) inner = inner.slice(sm[0].length);
      return { raw: src.slice(0, end), summary, body: inner.trim(), open: !!open[1] };
    }
  }
}
const Det = Details.extend({
  markdownTokenName: "details",
  parseMarkdown: (t, h) => h.createNode("details", {}, [
    h.createNode("detailsSummary", {}, t.summary ? [h.createTextNode(t.summary)] : []),
    h.createNode("detailsContent", {}, t.tokens?.length ? h.parseChildren(t.tokens) : [h.createNode("paragraph", {}, [])]),
  ]),
  renderMarkdown: (n, h) => {
    const [sum, body] = n.content ?? [];
    const title = escHtml((sum?.content ?? []).map((x: JSONContent) => x.text ?? "").join(""));
    const inner = body ? h.renderChildren(body.content ?? [], "\n\n").trim() : "";
    return `<details>\n<summary>${title}</summary>\n\n${inner ? `${inner}\n\n` : ""}</details>`;
  },
  markdownTokenizer: {
    name: "details", level: "block",
    start: lineStart(/\n {0,3}<details/i),
    tokenize: (src, _t, lx) => {
      const d = detailsAt(src);
      if (!d) return;
      return { type: "details", raw: d.raw, summary: d.summary, tokens: d.body ? lx.blockTokens(d.body) : [] };
    },
  },
}).configure({ persist: false, HTMLAttributes: { class: "md-details" } });
// 标题和内容由 details 自己写回，不单独认 markdown
const DetSum = DetailsSummary.extend({ parseMarkdown: undefined, renderMarkdown: undefined, markdownTokenizer: undefined });
const DetBody = DetailsContent.extend({ parseMarkdown: undefined, renderMarkdown: undefined, markdownTokenizer: undefined });

// ---------- [toc]：目录 ----------
// 单独一行的 [toc]（不分大小写）。目录里是这篇的所有标题，跟着标题变：显示时 render.ts 填，编辑时节点视图自己填
const TOC_RE = /^ {0,3}\[toc\][ \t]*(?:\n|$)/i;
export const tocEntries = (doc: { descendants: (f: (n: any) => boolean | void) => void }) => {
  const out: { level: number; text: string }[] = [];
  doc.descendants((n) => { if (n.type.name === "heading") { out.push({ level: n.attrs.level, text: n.textContent }); return false; } return n.type.name !== "toc"; });
  return out;
};
export const tocHtml = (es: { level: number; text: string }[]) =>
  es.length ? es.map((e) => `<div class="l${e.level}">${escHtml(e.text) || "&nbsp;"}</div>`).join("") : `<div class="none">No headings yet</div>`;
const Toc = Node.create({
  name: "toc",
  group: "block", atom: true, selectable: true, draggable: true,
  parseHTML: () => [{ tag: "nav[data-type=toc]" }],
  renderHTML: () => ["nav", { "data-type": "toc", class: "md-toc" }],
  addNodeView: () => ({ editor }) => {
    const dom = document.createElement("nav");
    dom.className = "md-toc";
    dom.dataset.type = "toc";
    dom.contentEditable = "false";
    let last = "";
    const fill = () => { const h = tocHtml(tocEntries(editor.state.doc)); if (h !== last) dom.innerHTML = last = h; };
    fill();
    editor.on("update", fill);
    return { dom, destroy: () => editor.off("update", fill), ignoreMutation: () => true };
  },
  parseMarkdown: () => ({ type: "toc" }),
  renderMarkdown: () => "[toc]",
  markdownTokenizer: {
    name: "toc", level: "block",
    start: lineStart(/\n {0,3}\[toc\][ \t]*(?:\n|$)/i),
    tokenize: (src) => { const m = TOC_RE.exec(src); return m ? { type: "toc", raw: m[0] } : undefined; },
  },
});

// ---------- :smile: 表情 ----------
// 存成 :名字:（和 Typora、GitHub 一样），显示成表情字。只认 emoji.ts 里有的名字；前面紧挨着字母数字的不算（1:100: 是比例）
const EMOJI_AT = /^:([a-z0-9_+-]+):/;
const isEmoji = (name: string) => Object.prototype.hasOwnProperty.call(EMOJI, name);
const emojiStart = (src: string) => {
  const re = /(?<![\p{L}\p{N}_]):([a-z0-9_+-]+):/gu;
  for (let m = re.exec(src); m; m = re.exec(src)) { if (isEmoji(m[1])) return m.index; re.lastIndex = m.index + 1; }
  return -1;
};
const Emoji = Node.create({
  name: "emoji",
  group: "inline", inline: true, atom: true, selectable: false,
  addAttributes() { return { name: { default: "", rendered: false } }; },
  parseHTML() { return [{ tag: "span[data-emoji]", getAttrs: (e) => ({ name: (e as HTMLElement).getAttribute("data-emoji") ?? "" }) }]; },
  renderHTML({ node }) { return ["span", { class: "md-emoji", "data-emoji": node.attrs.name, title: `:${node.attrs.name}:` }, EMOJI[node.attrs.name] ?? `:${node.attrs.name}:`]; },
  renderText: ({ node }) => EMOJI[node.attrs.name] ?? `:${node.attrs.name}:`,
  parseMarkdown: (t) => ({ type: "emoji", attrs: { name: t.name } }),
  renderMarkdown: (n) => `:${n.attrs?.name ?? ""}:`,
  markdownTokenizer: {
    name: "emoji", level: "inline",
    start: emojiStart,
    tokenize: (src) => {
      const m = EMOJI_AT.exec(src);
      if (!m || !isEmoji(m[1])) return;
      return { type: "emoji", raw: m[0], name: m[1] };
    },
  },
});

// ---------- [[引用]]（wiki 链接） ----------
// 存成 [[标题]]：可读，复制到别处也能按标题找。指向什么由用的一方定（setRefResolver、编辑器的 refs）。
// 节点名 cardRef、class、data 属性是最早的卡片引用留下的名字：改了就要动存下的文件和样式
const WikiRef = Node.create({
  name: "cardRef",
  group: "inline", inline: true, atom: true, selectable: true,
  addAttributes() { return { label: { default: "", rendered: false } }; },
  parseHTML() { return [{ tag: "span[data-cardref]", getAttrs: (e) => ({ label: (e as HTMLElement).getAttribute("data-cardref") ?? "" }) }]; },
  renderHTML({ node, HTMLAttributes }) { return ["span", mergeAttributes(HTMLAttributes, { class: "cref", "data-cardref": node.attrs.label }), node.attrs.label]; },
  renderText: ({ node }) => `[[${node.attrs.label}]]`,
  parseMarkdown: (t) => ({ type: "cardRef", attrs: { label: t.label } }),
  renderMarkdown: (n) => `[[${n.attrs?.label ?? ""}]]`,
  markdownTokenizer: {
    name: "cardRef", level: "inline",
    start: (src) => src.indexOf("[["),
    tokenize: (src) => {
      const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);
      if (!m) return;
      return { type: "cardRef", raw: m[0], label: m[1].trim() };
    },
  },
});

// ---------- 脚注：正文 [^1]，定义 [^1]: 内容（写回时按出现顺序重新编号） ----------
const FnRef = FootnoteReference.extend({
  // 打 [^1] 变引用；段首的先不变（可能是在写定义 [^1]: …，见 editor/typora.ts）
  addInputRules() {
    return [new InputRule({
      find: /\[\^([^\]\s]+)\]$/, undoable: true,
      handler: ({ state, range, chain }) => {
        if (range.from === state.doc.resolve(range.from).start()) return null;
        chain().deleteRange(range).addFootnote().run();
      },
    })];
  },
  // 显示和编辑一样：上标的编号（点击、双击跳到脚注由扩展自己按节点处理，不看 DOM）
  parseHTML: () => [{ tag: "sup.fnref", getAttrs: (e) => ({ "data-id": `fn-${e.textContent}`, referenceNumber: e.textContent }) }],
  renderHTML: ({ node }) => ["sup", { class: "fnref" }, String(node.attrs.referenceNumber ?? "?")],
  parseMarkdown: (t) => ({ type: "footnoteReference", attrs: { "data-id": `fn-${t.label}`, referenceNumber: t.label } }),
  // 编号在写回前按出现顺序重排好了（serializeMd）
  renderMarkdown: (n) => `[^${n.attrs?.referenceNumber ?? "?"}]`,
  markdownTokenizer: {
    name: "footnoteReference", level: "inline",
    start: (src) => src.indexOf("[^"),
    tokenize: (src) => {
      const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
      if (!m) return;
      return { type: "footnoteReference", raw: m[0], label: m[1] };
    },
  },
});
const FnDef = Footnote.extend({
  // 定义的 id 只给原版的锚点链接用（引用不再是链接）：不画
  renderHTML: () => ["li", 0],
  markdownTokenName: "footnoteDef",
  parseMarkdown: (t, h) => h.createNode("footnote", { "data-id": `fn-${t.label}`, id: `fn:${t.label}` }, t.tokens?.length ? h.parseChildren(t.tokens) : [h.createNode("paragraph", {}, [])]),
  renderMarkdown: undefined,
  markdownTokenizer: {
    name: "footnoteDef", level: "block",
    start: lineStart(/\n\[\^[^\]\s]+\]:/),
    tokenize: (src, _t, lx) => {
      // 第一行冒号后面的字，加上后面缩进的续行
      const m = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:(?: {2,}|\t)[^\n]*|[ \t]*(?=\n(?: {2,}|\t))))*)(?:\n|$)/.exec(src);
      if (!m) return;
      const body = m[2].replace(/^(?: {2,4}|\t)/gm, "");
      return { type: "footnoteDef", raw: m[0], label: m[1], tokens: lx.blockTokens(body) };
    },
  },
});
const FnList = Footnotes.extend({ markdownTokenName: "footnotes", markdownTokenizer: NO_OL_TOKENIZER, parseMarkdown: undefined, renderMarkdown: undefined, renderHTML: () => ["ol", { class: "footnotes" }, 0] });
// 文末可以有一个脚注列表，ProseMirror 就把它当成块后面的默认节点：gapcursor 只在默认节点是文字块的地方停，自己说可以停
// （停住以后打字、回车照样新起一段：它们找的是最近的文字块）
const Doc = Document.extend({ content: "block+ footnotes?", allowGapCursor: true });

// 图片是行内的：和字混在一段里照原样放（单独一段的图就是一段里只有它）。
// 缩小了的图写成 ![a](u){width=40%}（Pandoc 的写法）：宽度是正文宽的百分之几，卡片变宽变窄时图跟着缩放；没写的占满（最宽就是正文宽）
const IMG_WIDTH = /^\{width=(\d{1,3}(?:\.\d+)?)%\}/;
/** s 开头是图片的宽度写法时给它（0 < 宽度 ≤ 100，别的数不认，照字留着） */
function imageWidthAt(s: string): { width: number; raw: string } | undefined {
  const m = IMG_WIDTH.exec(s), w = m ? Number(m[1]) : 0;
  return m && w > 0 && w <= 100 ? { width: w, raw: m[0] } : undefined;
}
const pct = (v: string) => { const m = /^(\d+(?:\.\d+)?)%$/.exec(v.trim()); const w = m ? Number(m[1]) : 0; return w > 0 && w <= 100 ? w : null; };
const Img = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // TipTap 自带的 width 是像素，这里是百分比（null = 占满）；HTML 里是 style 的 width（复制粘贴时跟着走）
      width: { default: null, parseHTML: (e) => pct(e.style.width), renderHTML: (a) => (a.width ? { style: `width: ${a.width}%` } : {}) },
    };
  },
  parseMarkdown: (t, h) => h.createNode("image", { src: t.href, title: t.title, alt: t.text, width: t.width ?? null }),
  renderMarkdown(n, h, cx) { const md = this.parent!(n, h, cx); return n.attrs?.width ? `${md}{width=${n.attrs.width}%}` : md; },
}).configure({ inline: true, allowBase64: true });
// TipTap 的段落把只有一张图的一段解析成块级的图：这里图片是行内的，照样是一段
const Para = Paragraph.extend({
  parseMarkdown(t, h) { return t.tokens?.length === 1 && t.tokens[0].type === "image" ? h.createNode("paragraph", undefined, h.parseInline(t.tokens)) : this.parent?.(t, h) ?? []; },
});
// ---------- 原样的 HTML：<u>、<kbd> 是格式，<br> 是硬换行；别的标签和注释一字不改地留着 ----------
// 行内的（<span style=…>字</span>：开头标签到配对的结尾标签算一个）是 htmlInline，单独成块的（<div>…</div>、<!-- … -->）是 htmlBlock。
// 显示的是清洗过的 HTML；注释不显示，编辑时显示成淡色的源码（看得见、删得掉）。打的字里的 < 照旧转义成 \<（是字，不是 HTML）
export const isHtmlComment = (raw: string) => /^\s*<!--[\s\S]*-->\s*$/.test(raw);
const htmlNode = (name: "htmlInline" | "htmlBlock", tag: "span" | "div") => Node.create({
  name,
  ...(tag === "span" ? { group: "inline", inline: true } : { group: "block" }),
  atom: true, selectable: true,
  addAttributes: () => ({ raw: { default: "" } }),
  parseHTML: () => [{ tag: `${tag}[data-html]`, getAttrs: (e) => ({ raw: (e as HTMLElement).dataset.html ?? "" }) }],
  renderHTML: ({ node }) => [tag, { class: "md-html", "data-html": node.attrs.raw }],
  renderText: ({ node }) => node.attrs.raw,
  renderMarkdown: (n) => n.attrs?.raw ?? "",
  addNodeView: () => ({ node }) => {
    const dom = document.createElement(tag);
    dom.className = "md-html";
    dom.contentEditable = "false";
    const html = isHtmlComment(node.attrs.raw) ? "" : DOMPurify.sanitize(node.attrs.raw);
    dom.innerHTML = html;
    if (!dom.textContent?.trim() && !dom.querySelector("img, svg, video, iframe")) { dom.textContent = node.attrs.raw; dom.classList.add("src"); }
    return { dom, ignoreMutation: () => true };
  },
});
// 一个标签（属性照 CommonMark 的写法）、一段注释
const TAG = /^(?:<!--[\s\S]*?-->|<\/?([A-Za-z][\w-]*)(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/;
/** 行内的 HTML 从开头认一段：开头标签连同配对的结尾标签（中间同名的嵌套也算上）是一段，别的一个标签、一段注释自己是一段。配好对的 <u>…</u>、<kbd>…</kbd> 是格式，不归这里 */
function htmlInlineAt(src: string): string | undefined {
  const m = TAG.exec(src);
  if (!m) return;
  const name = m[1]?.toLowerCase();
  if ((name === "u" || name === "kbd") && new RegExp(`^<${name}>[\\s\\S]+?</${name}>`).test(src)) return;
  if (!name || m[0].startsWith("</") || m[0].endsWith("/>")) return m[0];
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = m[0].length;
  for (let depth = 1, t: RegExpExecArray | null; (t = re.exec(src));) if ((depth += t[1] ? -1 : 1) === 0) return src.slice(0, re.lastIndex);
  return m[0];
}
const HtmlInline = htmlNode("htmlInline", "span").extend({
  markdownTokenName: "htmlInline",
  parseMarkdown: (t) => { const raw = t.raw ?? ""; return /^<br\s*\/?>$/i.test(raw) ? { type: "hardBreak" } : { type: "htmlInline", attrs: { raw } }; },
  markdownTokenizer: {
    name: "htmlInline", level: "inline",
    start: (src) => src.indexOf("<"),
    tokenize: (src) => { const raw = htmlInlineAt(src); return raw ? { type: "htmlInline", raw } : undefined; },
  },
});
// 单独成块的 HTML：marked 的 html 块，原样留着
const HtmlBlock = htmlNode("htmlBlock", "div").extend({
  markdownTokenName: "html",
  parseMarkdown: (t) => { const raw = (t.text || t.raw || "").replace(/\s+$/, ""); return raw.trim() ? { type: "htmlBlock", attrs: { raw } } : []; },
});
// ---------- 行内格式的 Markdown 记号：唯一的一份（写回、光标处显示的记号、展开成原文都按它） ----------
// bold / italic / strike / code / link 的写回是 TipTap 自带的（和这里的记号一样），其余的写回用这张表
export const MARK_MD: Record<string, (attrs: Record<string, any>) => readonly [string, string]> = {
  bold: () => ["**", "**"], italic: () => ["*", "*"], strike: () => ["~~", "~~"], code: () => ["`", "`"],
  link: (a) => ["[", `](${a.href ?? ""})`],
  underline: () => ["<u>", "</u>"], kbd: () => ["<kbd>", "</kbd>"],
  highlight: () => ["==", "=="], subscript: () => ["~", "~"], superscript: () => ["^", "^"],
  annot: (a) => ["{", `|${escAnnot(a.note ?? "")}${annotOpts(a)}}`],
};
/**
 * 自己定义的格式的 Markdown 规则：re 从开头认一段（第 1 组是里面的字），记号来自 MARK_MD。
 * 打字时的转换不另写规则：编辑器照这里的解析重解析（editor/typora.ts）
 */
function mdSyntax(name: string, re: RegExp) {
  const [open, close] = MARK_MD[name]({}), tok = `x_${name}`;
  return {
    markdownTokenName: tok,
    parseMarkdown: (t: any, h: any) => h.applyMark(name, h.parseInline(t.tokens ?? [])),
    renderMarkdown: (n: JSONContent, h: any) => `${open}${h.renderChildren(n)}${close}`,
    markdownTokenizer: {
      name: tok, level: "inline" as const,
      start: (src: string) => src.indexOf(open),
      tokenize: (src: string, prev: { raw?: string }[], lx: any) => {
        // 紧跟在同样的记号后面的不开头（~~ 是删除线；==、^ 同理）
        if (prev[prev.length - 1]?.raw?.endsWith(open[0])) return;
        const m = re.exec(src);
        return m ? { type: tok, raw: m[0], tokens: lx.inlineTokens(m[1]) } : undefined;
      },
    },
  };
}
// ---------- <u>、<kbd> ----------
const U = Underline.extend(mdSyntax("underline", /^<u>([\s\S]+?)<\/u>/));
const Kbd = Mark.create({
  name: "kbd",
  excludes: "_",
  parseHTML: () => [{ tag: "kbd" }],
  renderHTML: ({ HTMLAttributes }) => ["kbd", HTMLAttributes, 0],
  ...mdSyntax("kbd", /^<kbd>([\s\S]+?)<\/kbd>/),
});
// ---------- ==高亮==、H~2~O、x^2^（Typora 的扩展语法） ----------
// 下标、上标照 Pandoc：中间不能有空白（要空白写 \ ），~ 只有一个（~~ 是删除线）；高亮 == 里两头不是空白
const SUB_RE = /^~(?!~)((?:\\.|[^~\s\\])+)~(?!~)/, SUP_RE = /^\^((?:\\.|[^\^\s\\])+)\^/, HL_RE = /^==(?=[^\s=])((?:\\.|[^\n\\])*?[^\s\\])==/;
const tagMark = (name: string, tag: string, re: RegExp) => Mark.create({
  name,
  parseHTML: () => [{ tag }],
  renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
  ...mdSyntax(name, re),
});
const Highlight = tagMark("highlight", "mark", HL_RE);

// ---------- {字|批注}、{字|批注|purple below}：贴在字上的手写标注（注音 ruby 的写法） ----------
// 和 ==高亮== 是两回事，各用各的记号。第三段可选：颜色（blue purple orange green，默认 blue）和 below（标签写在字下面）。
// 字和批注里的 { } | \ 写成 \{ \} \| \\；表格里 | 本来就要写成 \|。别的 Markdown 查看器里它原样显示成 {字|批注}，字不会丢
export const ANNOT_COLORS = ["blue", "purple", "orange", "green"] as const;
export type AnnotColor = (typeof ANNOT_COLORS)[number];
const ANNOT_PART = "((?:\\\\.|[^{}|\\n\\\\])+)";
const ANNOT_RE = new RegExp(`^\\{${ANNOT_PART}\\|${ANNOT_PART}(?:\\|([a-z ]*))?\\}`);
const escAnnot = (t: string) => t.replace(/[\\{}|]/g, "\\$&");
const annotOpts = (a: Record<string, any>) => { const o = [a.color && a.color !== "blue" ? a.color : "", a.below ? "below" : ""].filter(Boolean).join(" "); return o ? `|${o}` : ""; };
const Annot = Mark.create({
  name: "annot",
  inclusive: false,
  addAttributes() {
    return {
      note: { default: "", parseHTML: (e) => e.getAttribute("data-note") ?? "", renderHTML: (a) => ({ "data-note": a.note }) },
      color: { default: "blue", parseHTML: (e) => e.getAttribute("data-color") ?? "blue", renderHTML: (a) => (a.color && a.color !== "blue" ? { "data-color": a.color } : {}) },
      below: { default: false, parseHTML: (e) => e.hasAttribute("data-below"), renderHTML: (a) => (a.below ? { "data-below": "" } : {}) },
    };
  },
  parseHTML: () => [{ tag: "span.md-annot" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "md-annot" }), 0],
  markdownTokenName: "x_annot",
  parseMarkdown: (t: any, h: any) => h.applyMark("annot", h.parseInline(t.tokens ?? []), { note: t.note, color: t.color, below: t.below }),
  renderMarkdown: (n: JSONContent, h: any) => { const [a, b] = MARK_MD.annot(n.attrs ?? {}); return `${a}${h.renderChildren(n)}${b}`; },
  markdownTokenizer: {
    name: "x_annot", level: "inline",
    start: (src: string) => src.indexOf("{"),
    tokenize: (src: string, _prev: unknown, lx: any) => {
      const m = ANNOT_RE.exec(src);
      if (!m) return;
      const un = (t: string) => t.replace(/\\([\\{}|])/g, "$1"), opts = (m[3] ?? "").split(/\s+/);
      return { type: "x_annot", raw: m[0], tokens: lx.inlineTokens(un(m[1])), note: un(m[2]).trim(), color: ANNOT_COLORS.find((c) => opts.includes(c)) ?? "blue", below: opts.includes("below") };
    },
  },
});
const Sub = tagMark("subscript", "sub", SUB_RE);
const Sup = tagMark("superscript", "sup", SUP_RE);

// 分隔线只在回车时变（--- 打完就变会和 YAML 头、setext 标题冲突；见 editor/typora.ts）
const Hr = HorizontalRule.extend({ addInputRules: () => [] });
// 行内代码的打字规则在 editor/typora.ts（反引号按长度配对）
const InlineCode = CodeMark.extend({ addInputRules: () => [] });
// ---------- 列表 ----------
// 空的列表项只写记号（"2."、"-"、"- [ ]"），后面不留空格：写回时末尾的空白会被去掉，而 marked 把行尾带空格的 "- " 读成段落里的字
const bareEmpty = (n: JSONContent, md: string) => {
  const first = n.content?.[0];
  return first?.type === "paragraph" && !first.content?.length ? md.replace(/^([^\n]*?)[ \t]+(?=\n|$)/, "$1") : md;
};
const Item = ListItem.extend({ renderMarkdown(n, h, c) { return bareEmpty(n, String(this.parent?.(n, h, c) ?? "")); } });
// 有序列表：分词交给 marked（见 NO_OL_TOKENIZER），列表项和无序列表一样由 listItem 解析（空的项给一个空段落）
const Ordered = OrderedList.extend({
  markdownTokenizer: NO_OL_TOKENIZER,
  parseMarkdown: (t, h) => (t.type === "list" && t.ordered
    ? { type: "orderedList", ...(typeof t.start === "number" && t.start !== 1 ? { attrs: { start: t.start } } : {}), content: h.parseChildren(t.items ?? []) }
    : []),
});
// 勾选项：编辑器里是 TipTap 的节点视图（不带 data-type，样式靠这个属性，补上）；静态显示照 renderHTML，勾选框后面不要空的 span
const Task = TaskItem.extend({
  renderHTML: ({ node, HTMLAttributes }) => ["li", mergeAttributes(HTMLAttributes, { "data-type": "taskItem" }), ["label", ["input", { type: "checkbox", checked: node.attrs.checked ? "checked" : null }]], ["div", 0]],
  renderMarkdown(n, h, c) { return bareEmpty(n, String(this.parent?.(n, h, c) ?? "")); },
}).configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } });
// 勾选列表照 TipTap 的规则，只是空的勾选项（行里只有 "- [ ]"）也认
const TASK_ITEM = /^(\s*)([-+*])\s+\[([ xX])\](?:[ \t]+(.*))?$/;
const taskBlocks = (src: string, lx: any) => parseIndentedBlocks(src, {
  itemPattern: TASK_ITEM,
  extractItemData: (m) => ({ indentLevel: m[1].length, mainContent: m[4] ?? "", checked: m[3].toLowerCase() === "x" }),
  createToken: (d, nestedTokens) => ({ type: "taskItem", raw: "", mainContent: d.mainContent, indentLevel: d.indentLevel, checked: d.checked, text: d.mainContent, tokens: lx.inlineTokens(d.mainContent), nestedTokens }),
  customNestedParser: (body) => {
    const r = taskBlocks(body, lx);
    if (!r) return lx.blockTokens(body);
    const rest = body.slice(r.raw.length);
    return [{ type: "taskList", raw: r.raw, items: r.items }, ...(rest.trim() ? lx.blockTokens(rest) : [])];
  },
}, lx);
const Tasks = TaskList.extend({
  markdownTokenizer: {
    name: "taskList", level: "block",
    start: (src) => src.match(/^\s*[-+*]\s+\[[ xX]\](?:[ \t]|$)/m)?.index ?? -1,
    tokenize: (src, _t, lx) => { const r = taskBlocks(src, lx); return r ? { type: "taskList", raw: r.raw, items: r.items } : undefined; },
  },
});
// 表格：GFM 存不下合并单元格和一格多段，所以一格只放一段
const Cell = TableCell.extend({ content: "paragraph" });
// 表格前后不多写空行
const Tbl = Table.extend({
  renderMarkdown(n, h, c) { return String(this.parent?.(n, h, c) ?? "").replace(/^\n+|\n+$/g, ""); },
}).configure({ resizable: false });
const Head = TableHeader.extend({ content: "paragraph" });
// 链接：文字就是网址的写回裸网址（自动链接），不写成 [url](url)
const Lnk = Link.extend({
  renderMarkdown(n, h, c) {
    const href = n.attrs?.href ?? "";
    if (unshield(c.meta?.markText ?? "") === href && /^https?:\/\/\S+$/.test(href)) return h.renderChildren(n);
    return this.parent?.(n, h, c) ?? "";
  },
}).configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { class: "lnk", rel: null, target: null } });

/** 打字规则：匹配到的那一段里有行内代码时不算（规则的正则看的是整行的字，代码里的记号也在里面） */
const outsideCode = (r: InputRule) => new InputRule({ find: r.find, undoable: r.undoable, handler: (p) => (p.state.doc.rangeHasMark(p.range.from, p.range.to, p.state.schema.marks.code) ? null : r.handler(p)) });

/** 两边共用的扩展（只含 schema 和 markdown 规则；编辑器专用的插件在 editor/ 里另加） */
export const baseExtensions: AnyExtension[] = [
  // 标注、高亮排在所有格式前面：它们是最外层的那一层，里面再有粗体、链接时底色也是连着的一整段（排在后面会被拆成几段）
  Annot, Highlight,
  StarterKit.configure({
    document: false, paragraph: false, codeBlock: false, underline: false, trailingNode: false, bold: false, italic: false, strike: false, horizontalRule: false, code: false, link: false, listItem: false, orderedList: false,
    heading: { levels: [1, 2, 3, 4, 5, 6] },
  }),
  // 打字时的 **b** *i* ~~s~~ 不用 TipTap 自带的正则（要求开头记号前是空白：中文后面紧跟的 **粗体** 不变；整行的字连行内代码里的 ** 一起配对，
  // 会把代码里的记号吃掉），由编辑器按解析器重解析（editor/typora.ts 的 retype），和存回去再读进来的一样。
  // 粗体只认 **b**：__init__ 是代码里的名字（解析时 _ 也不当强调）；打 _i_ 照旧变斜体（存成 *i*），但不跨过行内代码
  Bold.extend({ addInputRules: () => [], addPasteRules() { return [markPasteRule({ find: starPasteRegex, type: this.type })]; } }),
  Italic.extend({ addInputRules() { return [outsideCode(markInputRule({ find: underscoreInputRegex, type: this.type }))]; } }),
  Strike.extend({ addInputRules: () => [] }),
  Lnk, U, Kbd, Hr, InlineCode, Sub, Sup, Toc,
  Item, Ordered, Doc, Para, Code, Tasks, Task, Img, Det, DetSum, DetBody, Math1, Math2,
  Tbl, TableRow, Head, Cell,
  WikiRef, Emoji, FnList, FnDef, FnRef, HtmlInline, HtmlBlock,
];

// ---------- 写回：少转义 ----------
// 原版把 \ ` * _ [ ] ~ 全部转义，还把 < & 变成实体：block_manager 会写成 block\_manager。这里只在重新解析会变样时才转义
const PUNCT = /[!-/:-@[-`{-~]/;
/**
 * 一行开头会被读成块的写法：# 标题、> 引用、- + * 列表、1. 1) 有序列表、--- *** ___ 分隔线、=== --- setext 标题的下划线、[toc]。
 * 匹配到的末尾就是要放 \ 的地方：有序列表转义的是数字后面的 . )（\1. 不是转义），别的是第一个记号。
 * 一行到这段字的末尾就算完（后面可能还有别的行内内容）：多转义一个 \ 不改意思，少转义会变结构
 */
const LINE_START = /^ {0,3}(?:\d{1,9}(?=[.)](?:[ \t]|$))|(?=#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|([-*_])[ \t]*(?:\1[ \t]*){2,}$|[-=]+[ \t]*$|\[toc\][ \t]*$))/gim;
const ESC = "\u0001"; // 行首要转义的位置先放个记号，escText 把它和后面那个字写成 \X
function escText(s: string): string {
  // * ~ ` 一段里只有一个时配不成对，不用转义；两边都是空白的 * ~ 也不会成强调（a * b）。_ 不当强调（解析时关掉了），不转义
  // 只数可能成对的（不是两边都空白的）
  const pairs = (c: string) => { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] === c && !(/\s/.test(s[i - 1] ?? " ") && /\s/.test(s[i + 1] ?? " "))) n++; return n > 1; };
  const star = pairs("*"), tilde = pairs("~"), tick = pairs("`");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i], next = s[i + 1] ?? "", prev = s[i - 1] ?? "";
    switch (c) {
      case ESC: out += `\\${next}`; i++; break;
      case "\\": out += !next || PUNCT.test(next) ? "\\\\" : c; break;
      case "`": out += tick ? "\\`" : c; break;
      case "*": case "~": out += (c === "*" ? star : tilde) && !(/\s/.test(prev || " ") && /\s/.test(next || " ")) ? `\\${c}` : c; break;
      case "[": out += next === "[" || next === "^" || /^[^\]]*\]\s*[(\[]/.test(s.slice(i + 1)) ? "\\[" : c; break;
      case "$": out += INLINE_MATH.test(s.slice(i)) ? "\\$" : c; break;
      case "<": out += /[A-Za-z/!?]/.test(next) ? "\\<" : c; break;
      // 字面的 ^2^、==x==：会被读成上标、高亮的才转义
      case "^": out += SUP_RE.test(s.slice(i)) && prev !== "^" ? "\\^" : c; break;
      case "=": out += HL_RE.test(s.slice(i)) && prev !== "=" ? "\\=" : c; break;
      // 字面的 {a|b}：会被读成标注的才转义
      case "{": out += ANNOT_RE.test(s.slice(i)) ? "\\{" : c; break;
      // 字面的 :smile:（会被读成表情的）：转义前一个冒号
      case ":": { const m = EMOJI_AT.exec(s.slice(i)); out += m && isEmoji(m[1]) && !/[\p{L}\p{N}_]/u.test(prev) ? "\\:" : c; break; }
      case "&": out += /^&(?:#\d+|#x[\da-f]+|\w+);/i.test(s.slice(i)) ? "&amp;" : c; break;
      default: out += c;
    }
  }
  return out;
}

const mm = new MarkdownManager({
  marked: (() => {
    const m = new Marked();
    // _ 不当强调：__init__、block_manager 都是代码里的名字
    m.use({ tokenizer: {
      emStrong(src: string) { return src[0] === "_" ? undefined : false; },
      // 图片后面紧跟的 {width=…%} 是它的宽度（见 Img），连同图片一起读掉
      link(this: Tokenizer, src: string) {
        const t = Tokenizer.prototype.link.call(this, src), w = t?.type === "image" ? imageWidthAt(src.slice(t.raw.length)) : undefined;
        return w ? { ...t!, raw: t!.raw + w.raw, width: w.width } : t ?? false;
      },
    } as any });
    return m as any;
  })(),
  extensions: baseExtensions,
});
let schema: Schema | undefined;
/** 这套扩展的 schema */
export const mdSchema = () => (schema ??= getSchema(baseExtensions));

// ---------- 包着行内原子节点的格式：**a $x$**、==:tada:==、[![i](u)](l) ----------
// @tiptap/markdown 只给字加格式（applyMarkToContent 只认 text，往下找 content），行内的公式、表情、图片、[[引用]] 这些没有内容的
// 节点就没了外面的格式；写回时它又在每个非文字节点前把格式全关掉。两头都在这里补：读的时候行内原子节点也带上格式，
// 写的时候带格式的原子节点先写成自己的 Markdown 字（见 toMd），和两边的字一起被同一对记号包住
const isMarkableLeaf = (type: string | undefined) => { const t = type ? mdSchema().nodes[type] : undefined; return !!t && t.isInline && t.isLeaf && type !== "hardBreak"; };
type ApplyMark = (mark: string, content: JSONContent[], attrs?: Record<string, any>) => JSONContent[];
const textMarks = (mm as unknown as { applyMarkToContent: ApplyMark }).applyMarkToContent.bind(mm);
(mm as unknown as { applyMarkToContent: ApplyMark }).applyMarkToContent = (mark, content, attrs) => content.flatMap((n) =>
  isMarkableLeaf(n.type) ? [{ ...n, marks: [...(n.marks ?? []), attrs ? { type: mark, attrs } : { type: mark }] }] : textMarks(mark, [n], attrs));

// 字的转义由 escText 决定：交给 MarkdownManager 之前，把它会转义、变实体的字符换成私用区的字，写完再换回来，它就原样写出
const SHIELD = 0xe200;
const shield = (s: string) => s.replace(/[&<>\\`*_[\]~]/g, (c) => String.fromCharCode(SHIELD + c.charCodeAt(0)));
const unshield = (s: string) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - SHIELD));
/** 文档内容 → Markdown。raw：字原样写出（不转义），把一段当 Markdown 源码重新解析时用（见 blockSource） */
function toMd(content: JSONContent[], raw: boolean): string {
  const { nodes, marks } = mdSchema();
  const prep = (ns: JSONContent[], code: boolean): JSONContent[] => ns.map((n, i) => {
    if (n.type === "text") {
      if (code || n.marks?.some((m) => marks[m.type]?.spec.code)) return n;
      // 标注里的字：{ } | 也要转义（它们会断开标注的写法）；紧跟在图片后面、会被读成它的宽度的 {width=…%} 也转义
      let t = raw ? n.text! : escText(n.text!);
      if (!raw && ns[i - 1]?.type === "image" && imageWidthAt(t)) t = `\\${t}`;
      return { ...n, text: shield(n.marks?.some((m) => m.type === "annot") && !raw ? t.replace(/(?<!\\)[{}|]/g, "\\$&") : t) };
    }
    // 带格式的行内原子节点：先写成它自己的 Markdown，当作带同样格式的字（不转义），格式的记号就包在它外面
    if (n.marks?.length && isMarkableLeaf(n.type)) return { type: "text", text: shield(mm.serialize({ type: "doc", content: [{ type: "paragraph", content: [{ ...n, marks: undefined }] }] }).replace(/^\n+|\n+$/g, "")), marks: n.marks };
    // 折叠块的标题由 details 自己写成 HTML 的字，不经过这里
    return n.content ? { ...n, content: prep(n.content, code || !!nodes[n.type!]?.spec.code || n.type === "detailsSummary") } : n;
  });
  return unshield(mm.serialize({ type: "doc", content: prep(content, false) }));
}

/** Markdown → 文档 JSON（脚注定义收到文末一个 footnotes 里，按引用顺序编号） */
export function parseMd(src: string): JSONContent {
  // 转义的 \$ 先换成占位字（解析器会把 \$ 和普通 $ 解成同一个字，后面就分不出哪个是转义过的），见 mathify / unDollar。
  // 链接地址 ](…) 和 <自动链接> 里不换（地址里的占位字会被当成非法字符丢掉）
  const doc = mm.parse(src.replace(/\r\n?/g, "\n").replace(/(\]\([^)\n]*\)|<[^>\s]*>)|\\([\\$])/g, (m, url, c) => (!url && c === "$" ? ESC_DOLLAR : m)));
  const defs = new Map<string, JSONContent>();
  const rest: JSONContent[] = [];
  for (const n of doc.content ?? []) if (n.type === "footnote") defs.set(n.attrs?.["data-id"], n); else rest.push(n);
  const refs: string[] = [];
  walk(rest, (n) => { if (n.type === "footnoteReference" && !refs.includes(n.attrs?.["data-id"])) refs.push(n.attrs?.["data-id"]); });
  if (refs.length) {
    walk(rest, (n) => { if (n.type === "footnoteReference") n.attrs = { ...n.attrs, referenceNumber: String(refs.indexOf(n.attrs?.["data-id"]) + 1) }; });
    rest.push({ type: "footnotes", content: refs.map((id, i) => ({ type: "footnote", content: defs.get(id)?.content ?? [{ type: "paragraph" }], attrs: { "data-id": id, id: `fn:${i + 1}` } })) });
  }
  if (!rest.length) rest.push({ type: "paragraph" });
  return { type: "doc", content: unDollar(mathify(rest)!) };
}
function walk(ns: JSONContent[] | undefined, f: (n: JSONContent) => void) {
  for (const n of ns ?? []) { f(n); walk(n.content, f); }
}

/** 文档 JSON → Markdown */
export function serializeMd(doc: JSONContent): string {
  const content = escPairs(unsource(doc.content ?? []));
  const fi = content.findIndex((n) => n.type === "footnotes");
  const fns = fi >= 0 ? content.splice(fi, 1)[0] : undefined;
  // 脚注按引用出现的顺序重新编号
  const num = new Map<string, number>();
  walk(content, (n) => { const id = n.attrs?.["data-id"]; if (n.type === "footnoteReference" && !num.has(id)) num.set(id, num.size + 1); });
  const renumber = (ns: JSONContent[]): JSONContent[] => ns.map((n) => {
    const k = n.type === "footnoteReference" ? num.get(n.attrs?.["data-id"]) : undefined;
    const m = k === undefined ? n : { ...n, attrs: { ...n.attrs, referenceNumber: String(k) } };
    return m.content ? { ...m, content: renumber(m.content) } : m;
  });
  let out = toMd(markStarts(dropEmpty(renumber(content))), false);
  // 还没写内容的脚注不写空定义（[^1] 读回来照样是脚注）
  const defs = (fns?.content ?? []).filter((f) => num.has(f.attrs?.["data-id"])).sort((a, b) => num.get(a.attrs!["data-id"])! - num.get(b.attrs!["data-id"])!)
    .map((f) => [num.get(f.attrs!["data-id"]), toMd(markStarts(renumber(f.content ?? [])), false).trim()] as const)
    .filter(([, body]) => body).map(([k, body]) => `[^${k}]: ${body.replace(/\n/g, "\n    ")}`);
  if (defs.length) out = `${out.trimEnd()}\n\n${defs.join("\n")}`;
  return unPair(out.replace(/^\n+/, "").replace(/\s+$/, ""));
}
/**
 * 一个块当成 Markdown 源码：字原样写出（不转义），重新解析时字里的 **b**、$m$、# 之类就生效（打字、接受补全、粘贴之后用）。
 * 打字时转义过的 \X 写成私用区的一个字：解析器当普通字，重新解析也不会变；parseSource 再变回带 mdEsc 标记的那一对
 */
export function blockSource(n: JSONContent): string {
  return toMd(escPairs(unsource([n])), true).replace(/^\n+/, "").replace(/\s+$/, "");
}
/** blockSource 的原文解析回来；inline：只要行内内容（# - 1. > 之类不当成块），解析出来不是一段行内内容时给 null */
export function parseSource(src: string, inline: boolean): JSONContent[] | null {
  const ns = inline ? inlineParse(src) : (parseMd(src).content ?? []).filter((n) => n.type !== "footnotes");
  return ns && restorePairs(ns);
}

// ---------- 光标处展开的 Markdown 原文（编辑器里的 mdSrc 标记，见 editor/source.ts） ----------
// 光标走进 **粗体**、链接、标题、行内公式时，那一段换成带 mdSrc 标记的原文（真的字，能改）；光标离开时把原文重新解析回去。
// 写出 Markdown 之前（保存、复制、原文模式）先在这里把还展开着的原文收回去，所以 mdSrc 永远不会写进文件
export const SRC_MARK = "mdSrc";
const INLINE_HEAD = "\uE026";
const isSrc = (n: JSONContent) => n.type === "text" && !!n.marks?.some((m) => m.type === SRC_MARK);
/** 一段行内原文解析回行内内容；两头的空白照留（解析会去掉）。前面垫一个字，# - 1. > 之类不会被当成块 */
export const parseInlineSrc = (src: string): JSONContent[] => inlineParse(src) ?? plain(src);
const plain = (t: string): JSONContent[] => (t ? [{ type: "text", text: t }] : []);
/** 同上；解析出来不是一段行内内容时给 null */
function inlineParse(src: string): JSONContent[] | null {
  const lead = /^\s*/.exec(src)![0], trail = src.slice(lead.length).match(/\s*$/)![0], core = src.slice(lead.length, src.length - trail.length);
  if (!core) return plain(src);
  const blocks = (parseMd(INLINE_HEAD + core).content ?? []).filter((n) => n.type !== "footnotes");
  const p = blocks[0], first = p?.content?.[0];
  if (blocks.length !== 1 || p.type !== "paragraph" || first?.type !== "text" || !first.text?.startsWith(INLINE_HEAD)) return null;
  const rest = first.text.slice(INLINE_HEAD.length);
  return [...plain(lead), ...(rest ? [{ ...first, text: rest }] : []), ...p.content!.slice(1), ...plain(trail)];
}
/**
 * 一个文字块里的原文收回去。keep(from, to, prefix)：这一段（块里的字偏移，行内节点算 1）留着不收（光标在里面）。
 * 标题开头的原文是它的 "## "：合法的就定级别（留着时也跟着改级别），收的时候不合法就变回普通段落、原文当正文
 */
export function unsourceBlock(b: JSONContent, keep: (from: number, to: number, prefix: boolean) => boolean = () => false): JSONContent {
  const cs = b.content ?? [];
  if (!cs.some(isSrc)) return b;
  let attrs = b.attrs, type = b.type;
  const out: JSONContent[] = [];
  let at = 0;
  for (let i = 0; i < cs.length;) {
    if (!isSrc(cs[i])) { out.push(cs[i]); at += cs[i].text?.length ?? 1; i++; continue; }
    let j = i, text = "";
    while (j < cs.length && isSrc(cs[j])) text += cs[j++].text ?? "";
    const from = at, to = at + text.length, prefix = from === 0 && type === "heading";
    // 标题的 "## "（后面紧跟着的字是正文）
    const head = prefix ? /^(#{1,6})[ \t]+/.exec(text) : null;
    if (head) attrs = { ...attrs, level: head[1].length };
    if (keep(from, to, prefix)) out.push(...cs.slice(i, j));
    else if (head) out.push(...parseInlineSrc(text.slice(head[0].length)));
    else {
      if (prefix) type = "paragraph";
      out.push(...parseInlineSrc(text));
    }
    at = to; i = j;
  }
  if (type !== b.type) attrs = undefined;
  return { ...b, type, ...(attrs ? { attrs } : { attrs: undefined }), content: out };
}
// ---------- 打字时的反斜杠转义（编辑器里的 mdEsc 标记） ----------
// 在编辑器里打 \* 时那个 \ 带 mdEsc 标记（光标不在旁边时不显示，Typora 一样）；写出时这一对原样写 \*，不再把 \ 当字转义成 \\\*。
// 先换成一个私用区的字（写出时不会被转义、不影响旁边的记号），写完再换回 \X
export const ESC_MARK = "mdEsc";
const PAIR0 = 0xe100;
function escPairs(ns: JSONContent[]): JSONContent[] {
  return ns.map((n) => {
    const cs = n.content;
    if (!cs?.some((c) => c.marks?.some((m) => m.type === ESC_MARK))) return cs ? { ...n, content: escPairs(cs) } : n;
    const out: JSONContent[] = [];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], esc = c.type === "text" && c.marks?.some((m) => m.type === ESC_MARK);
      if (!esc) { out.push(c); continue; }
      const marks = c.marks!.filter((m) => m.type !== ESC_MARK), rest = { ...c, marks: marks.length ? marks : undefined };
      const next = cs[i + 1], ch = next?.type === "text" ? next.text?.[0] : undefined;
      if (c.text === "\\" && ch && /[!-/:-@[-`{-~]/.test(ch)) {
        out.push({ ...next, text: String.fromCharCode(PAIR0 + ch.charCodeAt(0)) + next.text!.slice(1) });
        i++;
      } else out.push(rest);
    }
    return { ...n, content: out };
  });
}
const unPair = (s: string) => s.replace(/[\uE100-\uE17F]/g, (c) => `\\${String.fromCharCode(c.charCodeAt(0) - PAIR0)}`);
/** 私用区的 \X 变回带 mdEsc 标记的 \ 加那个字；代码、属性里的变回字面的 \X */
function restorePairs(ns: JSONContent[], code = false): JSONContent[] {
  const { nodes, marks } = mdSchema();
  return ns.flatMap((n): JSONContent[] => {
    const attrs = n.attrs && Object.fromEntries(Object.entries(n.attrs).map(([k, v]) => [k, typeof v === "string" ? unPair(v) : v]));
    const m: JSONContent = attrs ? { ...n, attrs } : n;
    if (m.content) return [{ ...m, content: restorePairs(m.content, code || !!nodes[m.type!]?.spec.code) }];
    const t = m.text;
    if (m.type !== "text" || !t || !/[\uE100-\uE17F]/.test(t)) return [m];
    if (code || m.marks?.some((k) => marks[k.type]?.spec.code)) return [{ ...m, text: unPair(t) }];
    const out: JSONContent[] = [];
    let acc = "";
    for (const c of t) {
      const k = c.charCodeAt(0) - PAIR0;
      if (k < 0 || k > 0x7f) { acc += c; continue; }
      if (acc) out.push({ ...m, text: acc });
      out.push({ ...m, text: "\\", marks: [...(m.marks ?? []), { type: ESC_MARK }] });
      acc = String.fromCharCode(k);
    }
    if (acc) out.push({ ...m, text: acc });
    return out;
  });
}

function unsource(ns: JSONContent[]): JSONContent[] {
  return ns.map((n) => (n.content?.some(isSrc) ? unsourceBlock(n) : n.content ? { ...n, content: unsource(n.content) } : n));
}

// 字里看着像 $公式$ 的（Pandoc 规则，和 INLINE_MATH 一样）变成公式：两头都是没转义的 $。转义过的 \$ 总是字面的 $（Typora 一样）：
// \$x$、\$x\$ 都是普通文字（打 $x$ 变成公式后 ⌘Z 撤回的就存成 \$x$）
const ESC_DOLLAR = "\uE024";
const TEXT_MATH = /(^|[^$\\\uE024])\$([^$\s\uE024](?:[^$\uE024]*[^$\s\\\uE024])?)\$(?![\d$\uE024])/g;
/** 占位字换回去：正文、链接地址里是 $；代码、公式源码、原样的 HTML 里原样是 \$ */
function unDollar(ns: JSONContent[], raw = false): JSONContent[] {
  const fix = (t: string, r: boolean) => (t.includes(ESC_DOLLAR) ? t.replaceAll(ESC_DOLLAR, r ? "\\$" : "$") : t);
  return ns.map((n) => {
    const r = raw || n.type === "codeBlock" || n.type === "htmlInline" || n.type === "htmlBlock";
    const out: JSONContent = { ...n };
    if (n.text !== undefined) out.text = fix(n.text, r || (n.marks ?? []).some((m) => m.type === "code"));
    if (n.attrs) out.attrs = Object.fromEntries(Object.entries(n.attrs).map(([k, v]) => [k, typeof v === "string" ? fix(v, r || k === "latex") : v]));
    if (n.content) out.content = unDollar(n.content, r);
    return out;
  });
}
function mathify(ns: JSONContent[] | undefined): JSONContent[] | undefined {
  if (!ns) return ns;
  const out: JSONContent[] = [];
  for (const n of ns) {
    if (n.type === "codeBlock") { out.push(n); continue; }
    if (n.type === "text" && n.text?.includes("$") && !(n.marks ?? []).some((m) => m.type === "code")) {
      let last = 0, m: RegExpExecArray | null;
      const t = n.text!;
      TEXT_MATH.lastIndex = 0;
      while ((m = TEXT_MATH.exec(t))) {
        const at = m.index + m[1].length;
        if (at > last) out.push({ ...n, text: t.slice(last, at) });
        out.push({ type: "inlineMath", attrs: { latex: m[2], display: false } });
        last = at + m[2].length + 2;
        TEXT_MATH.lastIndex = last;
      }
      if (last === 0) out.push(n);
      else if (last < t.length) out.push({ ...n, text: t.slice(last) });
      continue;
    }
    out.push(n.content ? { ...n, content: mathify(n.content) } : n);
  }
  return out;
}

// 空段落写不进 Markdown（TipTap 会写成多余的空行或 &nbsp;）：写回时去掉；表格格子里的、容器里唯一的一段留着
const HOLDS = new Set(["blockquote", "listItem", "taskItem", "detailsContent", "footnote"]);
function dropEmpty(ns: JSONContent[], holder = true): JSONContent[] {
  const kept = holder ? ns.filter((n) => !(n.type === "paragraph" && !n.content?.length)) : ns;
  return (kept.length ? kept : ns.slice(0, 1)).map((n) => (n.content && n.type !== "paragraph" ? { ...n, content: dropEmpty(n.content, HOLDS.has(n.type!)) } : n));
}

// 段落里每一行的开头（段首、硬换行后面、字里的换行后面）会被读成块的写法：转义（只看没有格式的字，有格式的前面有记号）
function markStarts(ns: JSONContent[]): JSONContent[] {
  return ns.map((n): JSONContent => {
    if (n.type !== "paragraph") return n.content ? { ...n, content: markStarts(n.content) } : n;
    let atLine = true;
    return {
      ...n,
      content: n.content?.map((t) => {
        const start = atLine;
        atLine = t.type === "hardBreak" || (t.type === "text" && !!t.text?.endsWith("\n"));
        if (t.type !== "text" || !t.text || t.marks?.length) return t;
        return { ...t, text: t.text.replace(LINE_START, (m0: string, _c: string, off: number) => (off === 0 && !start ? m0 : m0 + ESC)) };
      }),
    };
  });
}
