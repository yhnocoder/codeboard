// Markdown 的唯一一套 schema + 解析 / 写回：编辑器（懒加载）和其他卡片的静态显示都用它，所以编辑和显示长得一样。
// MarkdownManager 全应用只建一个，用自己的 marked 实例（@tiptap/markdown 默认往全局 marked 上挂规则，建几个就叠几层，解析会越来越慢）。
import { Mark, Node, mergeAttributes, type AnyExtension, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Bold, { starInputRegex, starPasteRegex } from "@tiptap/extension-bold";
import { InputRule, markInputRule, markPasteRule } from "@tiptap/core";
import Underline from "@tiptap/extension-underline";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import CodeMark from "@tiptap/extension-code";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import { MarkdownManager } from "@tiptap/markdown";
import { Marked } from "marked";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Footnotes, Footnote, FootnoteReference } from "tiptap-footnotes";
import DOMPurify from "dompurify";
import { lowlight } from "./hl";
import { EMOJI } from "./emoji";

// ---------- 公式：照旧版的 Pandoc 规则 ----------
// 行内 $…$：$ 后紧跟非空白，结尾 $ 前是非空白、后面不是数字，所以 "$5 and $10" 不算公式。行内的 $$…$$ 是行内的大号公式
const INLINE_MATH = /^\$\$([^$]+?)\$\$|^\$([^$\s](?:[^$]*[^$\s\\])?)\$(?!\d)/;
const Math1 = InlineMath.extend({
  addAttributes() {
    return { ...this.parent?.(), display: { default: false, parseHTML: (e) => e.getAttribute("data-display") === "yes", renderHTML: (a) => (a.display ? { "data-display": "yes" } : {}) } };
  },
  // 打字时的转换在编辑器里（editor/typora.ts，照 Pandoc 规则；TipTap 自带的把 $$x$$ 当行内小公式）
  addInputRules: () => [],
  parseMarkdown: (t) => ({ type: "inlineMath", attrs: { latex: t.latex, display: !!t.display } }),
  renderMarkdown: (n) => (n.attrs?.display ? `$$${n.attrs.latex}$$` : `$${n.attrs?.latex ?? ""}$`),
  markdownTokenizer: {
    name: "inlineMath", level: "inline",
    start: (src) => src.indexOf("$"),
    tokenize: (src, tokens) => {
      const prev = tokens[tokens.length - 1]?.raw;
      if (prev && /\\$/.test(prev)) return;
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

// ---------- 代码块：内容里有 ``` 时用更长的围栏 ----------
const Code = CodeBlockLowlight.extend({
  renderMarkdown: (n, h) => {
    const body = n.content ? h.renderChildren(n.content) : "";
    const run = Math.max(2, ...[...body.matchAll(/^ {0,3}(`{3,})/gm)].map((m) => m[1].length));
    const f = "`".repeat(run + 1);
    return `${f}${n.attrs?.language ?? ""}\n${body}\n${f}`;
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true });

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

// ---------- [toc]：目录（Typora #30） ----------
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

// ---------- :smile: 表情（Typora #31） ----------
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
  addAttributes() { return { name: { default: "" } }; },
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
  // 打完右边的冒号就变
  addInputRules() {
    return [new InputRule({
      find: /(?<![\p{L}\p{N}_]):([a-z0-9_+-]+):$/u,
      handler: ({ range, match, chain }) => {
        if (!isEmoji(match[1])) return null;
        chain().insertContentAt(range, { type: "emoji", attrs: { name: match[1] } }).run();
      },
    })];
  },
});

// ---------- [[卡片引用]] ----------
// 存成 [[标题]]：可读，复制到别的白板也能按标题找；渲染时先按 id、再按标题找卡（Card 改名时 actions 顺手改写引用）
export const CardRef = Node.create({
  name: "cardRef",
  group: "inline", inline: true, atom: true, selectable: true,
  addAttributes() { return { label: { default: "" } }; },
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
  parseMarkdown: (t) => ({ type: "footnoteReference", attrs: { "data-id": `fn-${t.label}`, referenceNumber: t.label } }),
  renderMarkdown: (n) => `[^${fnNum.get(n.attrs?.["data-id"]) ?? n.attrs?.referenceNumber ?? "?"}]`,
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
const FnList = Footnotes.extend({ markdownTokenName: "footnotes", parseMarkdown: undefined, renderMarkdown: undefined });
const Doc = Document.extend({ content: "block+ footnotes?" });

// ---------- 其他 ----------
// 图片是行内的：和字混在一段里照原样放（单独一段的图就是一段里只有它）
const Img = Image.configure({ inline: true, allowBase64: true });
// TipTap 的段落把只有一张图的一段解析成块级的图：这里图片是行内的，照样是一段
const Para = Paragraph.extend({
  parseMarkdown: (t: any, h: any) => (t.tokens?.length === 1 && t.tokens[0].type === "image" ? h.createNode("paragraph", undefined, h.parseInline(t.tokens)) : (Paragraph.config as any).parseMarkdown(t, h)),
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
const HtmlInline = htmlNode("htmlInline", "span"), HtmlBlock = htmlNode("htmlBlock", "div");
const htmlTok = (tag: string) => ({
  name: `html_${tag}`, level: "inline" as const,
  start: (src: string) => src.indexOf(`<${tag}>`),
  tokenize: (src: string, _t: unknown, lx: any) => {
    const m = new RegExp(`^<${tag}>([\\s\\S]+?)</${tag}>`).exec(src);
    if (!m) return;
    return { type: `html_${tag}`, raw: m[0], tokens: lx.inlineTokens(m[1]) };
  },
});
const U = Underline.extend({
  markdownTokenName: "html_u",
  parseMarkdown: (t: any, h: any) => h.applyMark("underline", h.parseInline(t.tokens ?? [])),
  renderMarkdown: (n: JSONContent, h: any) => `<u>${h.renderChildren(n)}</u>`,
  markdownTokenizer: htmlTok("u"),
});
const Kbd = Mark.create({
  name: "kbd",
  excludes: "_",
  parseHTML: () => [{ tag: "kbd" }],
  renderHTML: ({ HTMLAttributes }) => ["kbd", HTMLAttributes, 0],
  markdownTokenName: "html_kbd",
  parseMarkdown: (t: any, h: any) => h.applyMark("kbd", h.parseInline(t.tokens ?? [])),
  renderMarkdown: (n: JSONContent, h: any) => `<kbd>${h.renderChildren(n)}</kbd>`,
  markdownTokenizer: htmlTok("kbd"),
});
// ---------- ==高亮==、H~2~O、x^2^（Typora 的扩展语法，#32） ----------
// 下标、上标照 Pandoc：中间不能有空白（要空白写 \ ），~ 只有一个（~~ 是删除线）；高亮 == 里两头不是空白
const inlineTok = (name: string, open: string, re: RegExp) => ({
  name, level: "inline" as const,
  start: (src: string) => src.indexOf(open),
  tokenize: (src: string, _t: unknown, lx: any) => {
    const m = re.exec(src);
    if (!m) return;
    return { type: name, raw: m[0], tokens: lx.inlineTokens(m[1]) };
  },
});
const SUB_RE = /^~(?!~)((?:\\.|[^~\s\\])+)~(?!~)/, SUP_RE = /^\^((?:\\.|[^\^\s\\])+)\^/, HL_RE = /^==(?=[^\s=])((?:\\.|[^\n\\])*?[^\s\\])==/;
const wrapMark = (name: string, tag: string, md: string, re: RegExp, typed: RegExp) => Mark.create({
  name,
  parseHTML: () => [{ tag }],
  renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
  addInputRules() { return [markInputRule({ find: typed, type: this.type })]; },
  markdownTokenName: `x_${name}`,
  parseMarkdown: (t: any, h: any) => h.applyMark(name, h.parseInline(t.tokens ?? [])),
  renderMarkdown: (n: JSONContent, h: any) => `${md}${h.renderChildren(n)}${md}`,
  markdownTokenizer: inlineTok(`x_${name}`, md, re),
});
// 打字规则：结尾记号一打完就变；前面紧挨着同样的记号或 \ 时不算（~~ 是删除线、\~ 是字）
const Highlight = wrapMark("highlight", "mark", "==", HL_RE, /(?<![=\\])(==([^=\s](?:[^=]*[^=\s])?)==)$/);
const Sub = wrapMark("subscript", "sub", "~", SUB_RE, /(?<![~\\])(~([^~\s]+)~)$/);
const Sup = wrapMark("superscript", "sup", "^", SUP_RE, /(?<![\^\\])(\^([^\^\s]+)\^)$/);

// 分隔线只在回车时变（--- 打完就变会和 YAML 头、setext 标题冲突；见 editor/typora.ts）
const Hr = HorizontalRule.extend({ addInputRules: () => [] });
// 行内代码的打字规则在 editor/typora.ts（反引号按长度配对）
const InlineCode = CodeMark.extend({ addInputRules: () => [] });
// 编辑器里的勾选框节点视图不带 data-type：样式靠这个属性，补上
const Task = TaskItem.configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } });
// 表格：GFM 存不下合并单元格和一格多段，所以一格只放一段
const Cell = TableCell.extend({ content: "paragraph" });
// 表格前后不多写空行
const Tbl = Table.extend({ renderMarkdown: (n: JSONContent, h: any, c: any) => String((Table.config as any).renderMarkdown(n, h, c)).replace(/^\n+|\n+$/g, "") }).configure({ resizable: false });
const Head = TableHeader.extend({ content: "paragraph" });

/** 两边共用的扩展（只含 schema 和 markdown 规则；编辑器专用的插件在 editor/ 里另加） */
export const baseExtensions: AnyExtension[] = [
  StarterKit.configure({
    document: false, paragraph: false, codeBlock: false, underline: false, trailingNode: false, bold: false, horizontalRule: false, code: false,
    link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { class: "lnk", rel: null, target: null } },
    heading: { levels: [1, 2, 3, 4, 5, 6] },
  }),
  // 粗体只认 **b**：__init__ 是代码里的名字（解析时 _ 也不当强调）
  Bold.extend({ addInputRules() { return [markInputRule({ find: starInputRegex, type: this.type })]; }, addPasteRules() { return [markPasteRule({ find: starPasteRegex, type: this.type })]; } }),
  U, Kbd, Hr, InlineCode, Highlight, Sub, Sup, Toc,
  Doc, Para, Code, TaskList, Task, Img, Det, DetSum, DetBody, Math1, Math2,
  Tbl, TableRow, Head, Cell,
  CardRef, Emoji, FnList, FnDef, FnRef, HtmlInline, HtmlBlock,
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
    // _ 不当强调：__init__、block_manager 都是代码里的名字（旧版也只认 *）
    m.use({ tokenizer: { emStrong(src: string) { return src[0] === "_" ? undefined : false; } } as any });
    return m as any;
  })(),
  extensions: baseExtensions,
});
// 原样写出字（不转义）：把一段当 Markdown 源码重新解析时用（见 blockSource）
let rawText = false;
(mm as any).encodeTextForMarkdown = function (text: string, node: JSONContent, parent?: JSONContent) {
  if (rawText) return text;
  const codeTypes: Set<string> = (this as any).codeTypes;
  if ((parent?.type && codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => codeTypes.has(typeof m === "string" ? m : (m as any).type))) return text;
  return escText(text);
};
// 原样的 HTML（见 htmlNode）：TipTap 默认按 schema 解析 HTML，认不出的标签、注释都丢掉了，第一次保存时就从文件里删掉了
(mm as any).parseHTMLToken = (t: { raw?: string; text?: string; block?: boolean }): JSONContent | null => {
  const raw = t.block ? (t.text || t.raw || "").replace(/\s+$/, "") : t.text || t.raw || "";
  if (!raw.trim()) return null;
  if (/^<br\s*\/?>$/i.test(raw)) return { type: "hardBreak" };
  return { type: t.block ? "htmlBlock" : "htmlInline", attrs: { raw } };
};
// 链接：文字就是网址的写回裸网址（自动链接），不写成 [url](url)
const linkSpec = (mm as any).getHandlersForNodeType("link")[0];
if (linkSpec) {
  const orig = linkSpec.renderMarkdown;
  linkSpec.renderMarkdown = (n: JSONContent, h: any, ctx: any) => {
    const href = n.attrs?.href ?? "";
    if (ctx?.meta?.markText === href && /^https?:\/\/\S+$/.test(href)) return h.renderChildren(n);
    return orig(n, h, ctx);
  };
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

let fnNum = new Map<string, number>();
/** 文档 JSON → Markdown */
export function serializeMd(doc: JSONContent): string {
  const content = escPairs(unsource(doc.content ?? []));
  const fi = content.findIndex((n) => n.type === "footnotes");
  const fns = fi >= 0 ? content.splice(fi, 1)[0] : undefined;
  fnNum = new Map();
  walk(content, (n) => { if (n.type === "footnoteReference" && !fnNum.has(n.attrs?.["data-id"])) fnNum.set(n.attrs?.["data-id"], fnNum.size + 1); });
  let out = mm.serialize({ type: "doc", content: markStarts(dropEmpty(content)) });
  // 还没写内容的脚注不写空定义（[^1] 读回来照样是脚注）
  const defs = (fns?.content ?? []).filter((f) => fnNum.has(f.attrs?.["data-id"])).sort((a, b) => fnNum.get(a.attrs!["data-id"])! - fnNum.get(b.attrs!["data-id"])!)
    .map((f) => [fnNum.get(f.attrs!["data-id"]), mm.serialize({ type: "doc", content: markStarts(f.content ?? []) }).trim()] as const)
    .filter(([, body]) => body).map(([k, body]) => `[^${k}]: ${body.replace(/\n/g, "\n    ")}`);
  if (defs.length) out = `${out.trimEnd()}\n\n${defs.join("\n")}`;
  return unPair(out.replace(/^\n+/, "").replace(/\s+$/, ""));
}
/** 一个块当成 Markdown 源码：字原样写出（不转义），重新解析时字里的 **b**、$m$、# 之类就生效（接受补全、粘贴之后用） */
export function blockSource(n: JSONContent): string {
  rawText = true;
  try { return unPair(mm.serialize({ type: "doc", content: escPairs(unsource([n])) }).replace(/^\n+/, "").replace(/\s+$/, "")); } finally { rawText = false; }
}

// ---------- 光标处展开的 Markdown 原文（#11，编辑器里的 mdSrc 标记，见 editor/source.ts） ----------
// 光标走进 **粗体**、链接、标题、行内公式时，那一段换成带 mdSrc 标记的原文（真的字，能改）；光标离开时把原文重新解析回去。
// 写出 Markdown 之前（保存、复制、原文模式）先在这里把还展开着的原文收回去，所以 mdSrc 永远不会写进文件
export const SRC_MARK = "mdSrc";
const INLINE_HEAD = "\uE026";
const isSrc = (n: JSONContent) => n.type === "text" && !!n.marks?.some((m) => m.type === SRC_MARK);
/** 一段行内原文解析回行内内容；两头的空白照留（解析会去掉）。前面垫一个字，# - 1. > 之类不会被当成块 */
export function parseInlineSrc(src: string): JSONContent[] {
  const lead = /^\s*/.exec(src)![0], trail = src.slice(lead.length).match(/\s*$/)![0], core = src.slice(lead.length, src.length - trail.length);
  const plain = (t: string): JSONContent[] => (t ? [{ type: "text", text: t }] : []);
  if (!core) return plain(src);
  const blocks = parseMd(INLINE_HEAD + core).content ?? [];
  const p = blocks[0], first = p?.content?.[0];
  if (blocks.length !== 1 || p.type !== "paragraph" || first?.type !== "text" || !first.text?.startsWith(INLINE_HEAD)) return plain(src);
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
// ---------- 打字时的反斜杠转义（#27，编辑器里的 mdEsc 标记） ----------
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

function unsource(ns: JSONContent[]): JSONContent[] {
  return ns.map((n) => (n.content?.some(isSrc) ? unsourceBlock(n) : n.content ? { ...n, content: unsource(n.content) } : n));
}

// 字里看着像 $公式$ 的（Pandoc 规则）变成公式：旧版编辑器里打的 $\frac{a}{b}$ 没转成公式，写回成了 \$…\$，再读进来时转过来。
// 两头要是同一种 $：都没转义，或者都转义了（旧版的 \$…\$）。只转义了开头的 \$x$ 是现在的编辑器写下的普通文字（打 $x$ 变成公式后
// ⌘Z 撤回的就是这样存的），Typora 里也是字面的 $，不当公式
const ESC_DOLLAR = "\uE024";
const TEXT_MATH = /(^|[^$\\\uE024])([$\uE024])([^$\s\uE024](?:[^$\uE024]*[^$\s\\\uE024])?)\2(?![\d$\uE024])/g;
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
    if (n.type === "text" && /[$\uE024]/.test(n.text ?? "") && !(n.marks ?? []).some((m) => m.type === "code")) {
      let last = 0, m: RegExpExecArray | null;
      const t = n.text!;
      TEXT_MATH.lastIndex = 0;
      while ((m = TEXT_MATH.exec(t))) {
        const at = m.index + m[1].length;
        if (at > last) out.push({ ...n, text: t.slice(last, at) });
        out.push({ type: "inlineMath", attrs: { latex: m[3], display: false } });
        last = at + m[3].length + 2;
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
