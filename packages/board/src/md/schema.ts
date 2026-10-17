// Markdown 的唯一一套 schema + 解析 / 写回：编辑器（懒加载）和其他卡片的静态显示都用它，所以编辑和显示长得一样。
// MarkdownManager 全应用只建一个，用自己的 marked 实例（@tiptap/markdown 默认往全局 marked 上挂规则，建几个就叠几层，解析会越来越慢）。
import { Node, mergeAttributes, type AnyExtension, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Document from "@tiptap/extension-document";
import { MarkdownManager } from "@tiptap/markdown";
import { Marked } from "marked";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Footnotes, Footnote, FootnoteReference } from "tiptap-footnotes";
import { lowlight } from "./hl";

// ---------- 公式：照旧版的 Pandoc 规则 ----------
// 行内 $…$：$ 后紧跟非空白，结尾 $ 前是非空白、后面不是数字，所以 "$5 and $10" 不算公式。行内的 $$…$$ 是行内的大号公式
const INLINE_MATH = /^\$\$([^$]+?)\$\$|^\$([^$\s](?:[^$]*[^$\s\\])?)\$(?!\d)/;
const Math1 = InlineMath.extend({
  addAttributes() {
    return { ...this.parent?.(), display: { default: false, parseHTML: (e) => e.getAttribute("data-display") === "yes", renderHTML: (a) => (a.display ? { "data-display": "yes" } : {}) } };
  },
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
const lineStart = (re: RegExp) => (src: string) => { const m = re.exec(src); return m ? m.index + (m[0].startsWith("\n") ? 1 : 0) : -1; };
const Math2 = BlockMath.extend({
  renderMarkdown: (n) => `$$\n${n.attrs?.latex ?? ""}\n$$`,
  markdownTokenizer: {
    name: "blockMath", level: "block",
    start: lineStart(/(^|\n) {0,3}\$\$/),
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
    return `<details>\n<summary>${title}</summary>\n\n${inner}\n\n</details>`;
  },
  markdownTokenizer: {
    name: "details", level: "block",
    start: lineStart(/(^|\n) {0,3}<details/i),
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
    start: lineStart(/(^|\n)\[\^[^\]\s]+\]:/),
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
// 图片是块（单独一段的图解析出来就在块级）；和字混在一段里的，解析后把段落拆开（见 splitImages）
const Img = Image.configure({ allowBase64: true });
// 编辑器里的勾选框节点视图不带 data-type：样式靠这个属性，补上
const Task = TaskItem.configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } });
// 表格：GFM 存不下合并单元格和一格多段，所以一格只放一段
const Cell = TableCell.extend({ content: "paragraph" });
const Head = TableHeader.extend({ content: "paragraph" });

/** 两边共用的扩展（只含 schema 和 markdown 规则；编辑器专用的插件在 editor/ 里另加） */
export const baseExtensions: AnyExtension[] = [
  StarterKit.configure({
    document: false, codeBlock: false, underline: false, trailingNode: false,
    link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { class: "lnk", rel: null, target: null } },
    heading: { levels: [1, 2, 3, 4, 5, 6] },
  }),
  Doc, Code, TaskList, Task, Img, Det, DetSum, DetBody, Math1, Math2,
  Table.configure({ resizable: false }), TableRow, Head, Cell,
  CardRef, FnList, FnDef, FnRef,
];

// ---------- 写回：少转义 ----------
// 原版把 \ ` * _ [ ] ~ 全部转义，还把 < & 变成实体：block_manager 会写成 block\_manager。这里只在重新解析会变样时才转义
const PUNCT = /[!-/:-@[-`{-~]/;
const LINE_START = /(^|\n)( {0,3})(?=#{1,6}(?:\s|$)|>|[-+*]\s|\d{1,9}[.)]\s)/g;
const ESC = "\u0001"; // 段首要转义的位置先放个记号，escText 换成 \
function escText(s: string): string {
  // * ~ ` 一段里只有一个时配不成对，不用转义；两边都是空白的 * ~ 也不会成强调（a * b）。_ 不当强调（解析时关掉了），不转义
  // 只数可能成对的（不是两边都空白的）
  const pairs = (c: string) => { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] === c && !(/\s/.test(s[i - 1] ?? " ") && /\s/.test(s[i + 1] ?? " "))) n++; return n > 1; };
  const star = pairs("*"), tilde = pairs("~"), tick = pairs("`");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i], next = s[i + 1] ?? "", prev = s[i - 1] ?? "";
    switch (c) {
      case ESC: out += "\\"; break;
      case "\\": out += !next || PUNCT.test(next) ? "\\\\" : c; break;
      case "`": out += tick ? "\\`" : c; break;
      case "*": case "~": out += (c === "*" ? star : tilde) && !(/\s/.test(prev || " ") && /\s/.test(next || " ")) ? `\\${c}` : c; break;
      case "[": out += next === "[" || next === "^" || /^[^\]]*\]\s*[(\[]/.test(s.slice(i + 1)) ? "\\[" : c; break;
      case "$": out += INLINE_MATH.test(s.slice(i)) ? "\\$" : c; break;
      case "<": out += /[A-Za-z/!?]/.test(next) ? "&lt;" : c; break;
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
(mm as any).encodeTextForMarkdown = function (text: string, node: JSONContent, parent?: JSONContent) {
  const codeTypes: Set<string> = (this as any).codeTypes;
  if ((parent?.type && codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => codeTypes.has(typeof m === "string" ? m : (m as any).type))) return text;
  return escText(text);
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
  const doc = mm.parse(src.replace(/\r\n?/g, "\n"));
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
  return { type: "doc", content: splitImages(rest) };
}
function splitImages(ns: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const n of ns) {
    if (n.type === "paragraph" && n.content?.some((c) => c.type === "image")) {
      let cur: JSONContent[] = [];
      const flush = () => { while (cur[0]?.type === "text" && !cur[0].text?.trim()) cur.shift(); if (cur.length) out.push({ ...n, content: cur }); cur = []; };
      for (const c of n.content) if (c.type === "image") { flush(); out.push(c); } else cur.push(c);
      flush();
    } else out.push(n.content ? { ...n, content: splitImages(n.content) } : n);
  }
  return out;
}
function walk(ns: JSONContent[] | undefined, f: (n: JSONContent) => void) {
  for (const n of ns ?? []) { f(n); walk(n.content, f); }
}

let fnNum = new Map<string, number>();
/** 文档 JSON → Markdown */
export function serializeMd(doc: JSONContent): string {
  const content = [...(doc.content ?? [])];
  const fi = content.findIndex((n) => n.type === "footnotes");
  const fns = fi >= 0 ? content.splice(fi, 1)[0] : undefined;
  fnNum = new Map();
  walk(content, (n) => { if (n.type === "footnoteReference" && !fnNum.has(n.attrs?.["data-id"])) fnNum.set(n.attrs?.["data-id"], fnNum.size + 1); });
  let out = mm.serialize({ type: "doc", content: markStarts(content) });
  const defs = (fns?.content ?? []).filter((f) => fnNum.has(f.attrs?.["data-id"])).sort((a, b) => fnNum.get(a.attrs!["data-id"])! - fnNum.get(b.attrs!["data-id"])!)
    .map((f) => `[^${fnNum.get(f.attrs!["data-id"])}]: ${mm.serialize({ type: "doc", content: markStarts(f.content ?? []) }).trim().replace(/\n/g, "\n    ")}`);
  if (defs.length) out = `${out.trimEnd()}\n\n${defs.join("\n")}`;
  return out.replace(/^\n+/, "").replace(/\s+$/, "");
}
// 段落里行首的 # > - + * 1. 会被当成块语法：前面加 \（只看没有格式的开头文字）
function markStarts(ns: JSONContent[]): JSONContent[] {
  return ns.map((n): JSONContent => {
    if (n.type === "paragraph" || n.type === "heading") {
      if (!n.content?.length) return n;
      return { ...n, content: n.content.map((t, k) => (t.type === "text" && t.text && (k === 0 || t.text.includes("\n")) ? { ...t, text: t.text.replace(LINE_START, (m0, nl, sp, off) => (k > 0 && off === 0 && !nl ? m0 : `${nl}${sp}${ESC}`)) } : t)) };
    }
    return n.content ? { ...n, content: markStarts(n.content) } : n;
  });
}
