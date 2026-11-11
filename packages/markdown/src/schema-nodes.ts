// The nodes of the Markdown schema with their Markdown rules (tokenizing, reading, writing back) and their HTML
import { Node, mergeAttributes, parseIndentedBlocks, type AnyExtension, type JSONContent } from "@tiptap/core";
import type { MarkdownLexerConfiguration as Lexer } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import CodeBlock from "@tiptap/extension-code-block";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import { TaskList, TaskItem, ListItem, OrderedList } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import { Table, TableHeader, TableCell } from "@tiptap/extension-table";
import { Footnotes, Footnote, FootnoteReference } from "tiptap-footnotes";
import DOMPurify from "dompurify";
import { EMOJI } from "./emoji";
import { captionOf } from "./image";
import { imageAttrsText } from "./imageattrs";

// 行内 $…$：$ 后紧跟非空白，结尾 $ 前是非空白、后面不是数字，所以 "$5 and $10" 不算公式；紧跟在 \ 或 $ 后面的 $ 不开头。
// 行内的 $$…$$ 是行内的大号公式
const INLINE_MATH = /^\$\$([^$]+?)\$\$|^\$([^$\s](?:[^$]*[^$\s\\])?)\$(?!\d)/;
/** 排好的公式（KaTeX、MathML）里的 TeX 原文；没有的不当公式（按字读进来） */
const texAttrs = (e: HTMLElement) => {
  const tex = (
    e.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
    (e.matches(".katex[data-latex]") ? e : e.querySelector(".katex[data-latex]"))?.getAttribute("data-latex")
  )?.trim();
  return tex ? { latex: tex } : false;
};
export type MathToken = { raw: string; latex: string; display: boolean };
/** 行内公式的分词规则，解析、粘贴进来的 HTML 里的字、写回时的转义都照它：src 从一个 $ 开始，prev 是紧挨在它前面的那个字 */
export function mathAt(src: string, prev: string): MathToken | null {
  if (prev === "\\" || prev === "$") return null;
  const m = INLINE_MATH.exec(src);
  return m && { raw: m[0], latex: (m[1] ?? m[2]).trim(), display: m[1] !== undefined };
}
/** 一段字里的行内公式（粘贴进来的 HTML 里，网页没排出来、原样留着 $ 的）：拆成字和公式，prev 是这段字前面的那个字 */
export function splitMath(t: string, prev = ""): ({ text: string } | MathToken)[] {
  const out: ({ text: string } | MathToken)[] = [];
  let last = 0;
  for (let i = t.indexOf("$"); i >= 0; i = t.indexOf("$", i + 1)) {
    const m = mathAt(t.slice(i), i ? t[i - 1] : prev);
    if (!m) continue;
    if (i > last) out.push({ text: t.slice(last, i) });
    out.push(m);
    last = i + m.raw.length;
    i = last - 1;
  }
  if (last < t.length) out.push({ text: t.slice(last) });
  return out;
}
export const Math1 = InlineMath.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      display: {
        default: false,
        parseHTML: (e) => e.getAttribute("data-display") === "yes",
        renderHTML: (a) => (a.display ? { "data-display": "yes" } : {}),
      },
    };
  },
  // 别处排好的公式（网页、聊天应用里 KaTeX / MathML 画的）粘贴进来：TeX 原文在 MathML 的 annotation 里
  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: "span.katex", getAttrs: texAttrs }, { tag: "math", getAttrs: texAttrs }];
  },
  parseMarkdown: (t) => ({ type: "inlineMath", attrs: { latex: t.latex, display: !!t.display } }),
  renderMarkdown: (n) => (n.attrs?.display ? `$$${n.attrs.latex}$$` : `$${n.attrs?.latex ?? ""}$`),
  markdownTokenizer: {
    name: "inlineMath",
    level: "inline",
    start: (src) => src.indexOf("$"),
    tokenize: (src, tokens) => {
      const m = mathAt(src, tokens[tokens.length - 1]?.raw?.slice(-1) ?? "");
      return m ? { type: "inlineMath", ...m } : undefined;
    },
  },
});
// 块公式：$$ 单独起一行（或 $$…$$ 占满一行）
const BLOCK_MATH = /^ {0,3}\$\$([^$]+?)\$\$[ \t]*(?:\n|$)/;
/**
 * 块的 start：marked 拿它找一段字在哪断开，传的是 src.slice(1)，^ 会落在行中间（\[^1]: 的 \ 后面）。
 * 只认换行后面的那一处（re 以 \n 开头）；在行首的由 tokenize 直接认
 */
const lineStart = (re: RegExp) => (src: string) => {
  const m = re.exec(src);
  return m ? m.index + 1 : -1;
};
/**
 * 有序列表交给 marked 自己的列表规则（CommonMark）：TipTap 另写的那套要求记号后面有字，空的 "2." 会被读成上一项的续行。
 * 关掉它要换成一个什么都不认的分词器（写 undefined 会取回父扩展的那个）；脚注列表是从有序列表扩展来的，也带着它
 */
const NO_OL_TOKENIZER = { name: "orderedList", level: "block" as const, start: () => -1, tokenize: () => undefined };
export const Math2 = BlockMath.extend({
  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      { tag: ".katex-display", getAttrs: texAttrs },
      { tag: 'math[display="block"]', priority: 60, getAttrs: texAttrs },
    ];
  },
  addInputRules: () => [],
  renderMarkdown: (n) => `$$\n${n.attrs?.latex ?? ""}\n$$`,
  markdownTokenizer: {
    name: "blockMath",
    level: "block",
    start: lineStart(/\n {0,3}\$\$/),
    tokenize: (src) => {
      const m = BLOCK_MATH.exec(src);
      if (!m) return;
      return { type: "blockMath", raw: m[0], latex: m[1].trim() };
    },
  },
});

// isolating：编辑时代码块是一个自己管光标的代码编辑器（editor/codeblock.ts），对 ProseMirror 来说是封闭的块，
// 两个代码块之间、文档头尾的代码块外面才停得住光标（gapcursor 只认两边封闭的位置）
export const Code = CodeBlock.extend({
  isolating: true,
  addAttributes() {
    return {
      language: {
        default: null,
        rendered: false,
        parseHTML: (e) =>
          e.getAttribute("data-lang") ?? /\blanguage-(\S+)/.exec(e.firstElementChild?.className ?? "")?.[1] ?? null,
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

/** Text into HTML: & < > escaped */
export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unHtml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
function detailsAt(src: string) {
  const open = /^ {0,3}<details(\s+open)?\s*>[ \t]*\n?/i.exec(src);
  if (!open) return;
  const re = /<details(\s[^>]*)?>|<\/details\s*>/gi;
  re.lastIndex = open[0].length;
  let depth = 1,
    m: RegExpExecArray | null;
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
export const Det = Details.extend({
  markdownTokenName: "details",
  parseMarkdown: (t, h) =>
    h.createNode("details", {}, [
      h.createNode("detailsSummary", {}, t.summary ? [h.createTextNode(t.summary)] : []),
      h.createNode(
        "detailsContent",
        {},
        t.tokens?.length ? h.parseChildren(t.tokens) : [h.createNode("paragraph", {}, [])],
      ),
    ]),
  renderMarkdown: (n, h) => {
    const [sum, body] = n.content ?? [];
    const title = escHtml((sum?.content ?? []).map((x: JSONContent) => x.text ?? "").join(""));
    const inner = body ? h.renderChildren(body.content ?? [], "\n\n").trim() : "";
    return `<details>\n<summary>${title}</summary>\n\n${inner ? `${inner}\n\n` : ""}</details>`;
  },
  markdownTokenizer: {
    name: "details",
    level: "block",
    start: lineStart(/\n {0,3}<details/i),
    tokenize: (src, _t, lx) => {
      const d = detailsAt(src);
      if (!d) return;
      return { type: "details", raw: d.raw, summary: d.summary, tokens: d.body ? lx.blockTokens(d.body) : [] };
    },
  },
}).configure({ persist: false, HTMLAttributes: { class: "md-details" } });
// 标题和内容由 details 自己写回，不单独认 markdown
export const DetSum = DetailsSummary.extend({
  parseMarkdown: undefined,
  renderMarkdown: undefined,
  markdownTokenizer: undefined,
});
export const DetBody = DetailsContent.extend({
  parseMarkdown: undefined,
  renderMarkdown: undefined,
  markdownTokenizer: undefined,
});

// 单独一行的 [toc]（不分大小写）。目录里是这篇的所有标题，跟着标题变：显示时 render.ts 填，编辑时节点视图自己填
const TOC_RE = /^ {0,3}\[toc\][ \t]*(?:\n|$)/i;
// the editor keeps headings as paragraphs of source ("## text", editor/srcdoc.ts): those count too (never in a table cell)
const HEAD_SRC = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
export const tocEntries = (doc: PMNode) => {
  const out: { level: number; text: string }[] = [];
  doc.descendants((n, _pos, parent) => {
    if (n.type.name === "heading") {
      out.push({ level: n.attrs.level, text: n.textContent });
      return false;
    }
    if (n.type.name === "paragraph") {
      const m = /cell|header/.test(parent?.type.spec.tableRole ?? "") ? null : HEAD_SRC.exec(n.textContent);
      if (m)
        out.push({
          level: m[1].length,
          text: n.textContent
            .slice(m[0].length)
            .replace(/[ \t]+#+[ \t]*$/, "")
            .trim(),
        });
      return false;
    }
    return n.type.name !== "toc";
  });
  return out;
};
export const tocHtml = (es: { level: number; text: string }[]) =>
  es.length
    ? es.map((e) => `<div class="l${e.level}">${escHtml(e.text) || "&nbsp;"}</div>`).join("")
    : `<div class="none">No headings yet</div>`;
export const Toc = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: "nav[data-type=toc]" }],
  renderHTML: () => ["nav", { "data-type": "toc", class: "md-toc" }],
  addNodeView:
    () =>
    ({ editor }) => {
      const dom = document.createElement("nav");
      dom.className = "md-toc";
      dom.dataset.type = "toc";
      dom.contentEditable = "false";
      let last = "";
      const fill = () => {
        const h = tocHtml(tocEntries(editor.state.doc));
        if (h !== last) dom.innerHTML = last = h;
      };
      fill();
      editor.on("update", fill);
      return { dom, destroy: () => editor.off("update", fill), ignoreMutation: () => true };
    },
  parseMarkdown: () => ({ type: "toc" }),
  renderMarkdown: () => "[toc]",
  markdownTokenizer: {
    name: "toc",
    level: "block",
    start: lineStart(/\n {0,3}\[toc\][ \t]*(?:\n|$)/i),
    tokenize: (src) => {
      const m = TOC_RE.exec(src);
      return m ? { type: "toc", raw: m[0] } : undefined;
    },
  },
});

// 存成 :名字:（和 Typora、GitHub 一样），显示成表情字。只认 emoji.ts 里有的名字；前面紧挨着字母数字的不算（1:100: 是比例）
export const EMOJI_AT = /^:([a-z0-9_+-]+):/;
export const isEmoji = (name: string) => Object.prototype.hasOwnProperty.call(EMOJI, name);
const emojiStart = (src: string) => {
  const re = /(?<![\p{L}\p{N}_]):([a-z0-9_+-]+):/gu;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (isEmoji(m[1])) return m.index;
    re.lastIndex = m.index + 1;
  }
  return -1;
};
export const Emoji = Node.create({
  name: "emoji",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { name: { default: "", rendered: false } };
  },
  parseHTML() {
    return [
      { tag: "span[data-emoji]", getAttrs: (e) => ({ name: (e as HTMLElement).getAttribute("data-emoji") ?? "" }) },
    ];
  },
  renderHTML({ node }) {
    return [
      "span",
      { class: "md-emoji", "data-emoji": node.attrs.name, title: `:${node.attrs.name}:` },
      EMOJI[node.attrs.name] ?? `:${node.attrs.name}:`,
    ];
  },
  renderText: ({ node }) => EMOJI[node.attrs.name] ?? `:${node.attrs.name}:`,
  parseMarkdown: (t) => ({ type: "emoji", attrs: { name: t.name } }),
  renderMarkdown: (n) => `:${n.attrs?.name ?? ""}:`,
  markdownTokenizer: {
    name: "emoji",
    level: "inline",
    start: emojiStart,
    tokenize: (src) => {
      const m = EMOJI_AT.exec(src);
      if (!m || !isEmoji(m[1])) return;
      return { type: "emoji", raw: m[0], name: m[1] };
    },
  },
});

// 存成 [[标题]]：可读，复制到别处也能按标题找。指向什么由用的一方定（Markdown 实例的 refs、编辑器的 refs）。
// 从 [[ 列表选的还在标题后面带着目标的 id：[[标题#^id]]，改了名也认得出（显示的是目标现在的名字，原文里的标题只是给人读、找不到 id 时按它找）。
// 为什么是 #^：和 Obsidian 的块 id（[[页面#^id]]）一个写法；| 会把 GFM 表格的格子切开，单个 # 常出现在标题里（Issue #12），
// 而 id 只有 [\w-]（跨白板的是 白板id/卡id），标题以 #^字母 结尾的几乎没有
const REF_TARGET = /#\^([\w-]+(?:\/[\w-]+)?)$/;
/** [[…]] 里的字 → 标题和目标的 id（没有 id 的只有标题） */
function splitRef(inner: string): { label: string; target?: string } {
  const m = REF_TARGET.exec(inner);
  return m ? { label: inner.slice(0, m.index).trim(), target: m[1] } : { label: inner.trim() };
}
/** The Markdown of a reference. A target REF_TARGET cannot read back (other than [\w-] or board/card) is left out: it would read
 *  back as part of the title */
export const refSource = (label: string, target?: string) =>
  `[[${label}${target && REF_TARGET.test(`#^${target}`) ? `#^${target}` : ""}]]`;
export const WikiRef = Node.create({
  name: "wikiRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { label: { default: "", rendered: false }, target: { default: "", rendered: false } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-ref]",
        getAttrs: (e) => ({
          label: (e as HTMLElement).getAttribute("data-ref") ?? "",
          target: (e as HTMLElement).getAttribute("data-target") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "md-ref",
        "data-ref": node.attrs.label,
        ...(node.attrs.target ? { "data-target": node.attrs.target } : {}),
      }),
      node.attrs.label,
    ];
  },
  // 纯文字（别的应用）只要可读的标题
  renderText: ({ node }) => `[[${node.attrs.label}]]`,
  parseMarkdown: (t) => ({ type: "wikiRef", attrs: { label: t.label, target: t.target ?? "" } }),
  renderMarkdown: (n) => refSource(n.attrs?.label ?? "", n.attrs?.target || undefined),
  markdownTokenizer: {
    name: "wikiRef",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenize: (src) => {
      const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);
      if (!m) return;
      const r = splitRef(m[1]);
      if (!r.label) return;
      return { type: "wikiRef", raw: m[0], ...r };
    },
  },
});

export const FnRef = FootnoteReference.extend({
  // 显示和编辑一样：上标的编号（点击、双击跳到脚注由扩展自己按节点处理，不看 DOM）
  parseHTML: () => [
    { tag: "sup.fnref", getAttrs: (e) => ({ "data-id": `fn-${e.textContent}`, referenceNumber: e.textContent }) },
  ],
  renderHTML: ({ node }) => ["sup", { class: "fnref" }, String(node.attrs.referenceNumber ?? "?")],
  parseMarkdown: (t) => ({
    type: "footnoteReference",
    attrs: { "data-id": `fn-${t.label}`, referenceNumber: t.label },
  }),
  // 编号在写回前按出现顺序重排好了（serializeMd）
  renderMarkdown: (n) => `[^${n.attrs?.referenceNumber ?? "?"}]`,
  markdownTokenizer: {
    name: "footnoteReference",
    level: "inline",
    start: (src) => src.indexOf("[^"),
    tokenize: (src) => {
      const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
      if (!m) return;
      return { type: "footnoteReference", raw: m[0], label: m[1] };
    },
  },
});
export const FnDef: AnyExtension = Footnote.extend({
  // 定义的 id 只给原版的锚点链接用（引用不再是链接）：不画
  renderHTML: () => ["li", 0],
  markdownTokenName: "footnoteDef",
  parseMarkdown: (t, h) =>
    h.createNode(
      "footnote",
      { "data-id": `fn-${t.label}`, id: `fn:${t.label}` },
      t.tokens?.length ? h.parseChildren(t.tokens) : [h.createNode("paragraph", {}, [])],
    ),
  renderMarkdown: undefined,
  markdownTokenizer: {
    name: "footnoteDef",
    level: "block",
    start: lineStart(/\n\[\^[^\]\s]+\]:/),
    tokenize: (src, _t, lx) => {
      // 第一行冒号后面的字，加上后面缩进的续行
      const m = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:(?: {2,}|\t)[^\n]*|[ \t]*(?=\n(?: {2,}|\t))))*)(?:\n|$)/.exec(
        src,
      );
      if (!m) return;
      const body = m[2].replace(/^(?: {2,4}|\t)/gm, "");
      return { type: "footnoteDef", raw: m[0], label: m[1], tokens: lx.blockTokens(body) };
    },
  },
});
export const FnList = Footnotes.extend({
  markdownTokenName: "footnotes",
  markdownTokenizer: NO_OL_TOKENIZER,
  parseMarkdown: undefined,
  renderMarkdown: undefined,
  renderHTML: () => ["ol", { class: "footnotes" }, 0],
});
// 文末可以有一个脚注列表，ProseMirror 就把它当成块后面的默认节点：gapcursor 只在默认节点是文字块的地方停，自己说可以停
// （停住以后打字、回车照样新起一段：它们找的是最近的文字块）
export const Doc = Document.extend({ content: "block+ footnotes?", allowGapCursor: true });

// 图片是行内的：和字混在一段里照原样放（单独一段的图就是一段里只有它）。
// 缩小了的图写成 ![a](u){width=40%}（Pandoc 的写法）：宽度是正文宽的百分之几，卡片变宽变窄时图跟着缩放；没写的占满（最宽就是正文宽）。
// 同一个块里还有动图停在哪一帧（frame=N）、是否一直播放（loop=true）：imageattrs.ts
/**
 * ![alt](…) whose address CommonMark does not accept (spaces, an unencoded <svg> in a data: URL): still an image, one that is
 * never loaded and shows as an image that failed to load. Its source stays as written
 */
const BROKEN_IMAGE = /^!\[((?:\\.|[^\]\\\n])*)\]\(([^)\n]*)\)/;
export function brokenImage(src: string) {
  const m = BROKEN_IMAGE.exec(src);
  return m
    ? { type: "image", raw: m[0], href: m[2].trim(), title: null, text: m[1], tokens: [], broken: true }
    : undefined;
}
const pct = (v: string) => {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(v.trim());
  const w = m ? Number(m[1]) : 0;
  return w > 0 && w <= 100 ? w : null;
};
export const Img = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // TipTap 自带的 width 是像素，这里是百分比（null = 占满）；HTML 里是 style 的 width（复制粘贴时跟着走）
      width: {
        default: null,
        parseHTML: (e) => pct(e.style.width),
        renderHTML: (a) => (a.width ? { style: `width: ${a.width}%` } : {}),
      },
      // an animated image's still frame (from 1; null = the first) and always-play (imageattrs.ts); data attributes in HTML
      frame: {
        default: null,
        parseHTML: (e) => Number(e.getAttribute("data-frame")) || null,
        renderHTML: (a) => (a.frame ? { "data-frame": String(a.frame) } : {}),
      },
      loop: {
        default: false,
        parseHTML: (e) => e.hasAttribute("data-loop"),
        renderHTML: (a) => (a.loop ? { "data-loop": "" } : {}),
      },
      // an address the parser could not read (brokenImage): drawn as a failed image, never loaded
      broken: { default: false, parseHTML: () => false, renderHTML: () => ({}) },
    };
  },
  parseMarkdown: (t, h) =>
    h.createNode("image", {
      src: t.href,
      title: t.title,
      alt: t.text,
      width: t.attrs?.width ?? null,
      frame: t.attrs?.frame ?? null,
      loop: !!t.attrs?.loop,
      broken: !!t.broken,
    }),
  // title 是图注（显示在图下面）：TipTap 自己写的 "title" 不转义引号，这里转义 \ 和 "，换行并成空格（标题只能一行）
  renderMarkdown(n) {
    const a = n.attrs ?? {},
      t = String(a.title ?? "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
    return `![${a.alt ?? ""}](${a.src ?? ""}${t ? ` "${t.replace(/[\\"]/g, "\\$&")}"` : ""})${imageAttrsText(a)}`;
  },
}).configure({ inline: true, allowBase64: true });
// TipTap 的段落把只有一张图的一段解析成块级的图：这里图片是行内的，照样是一段
export const Para = Paragraph.extend({
  parseMarkdown(t, h) {
    return t.tokens?.length === 1 && t.tokens[0].type === "image"
      ? h.createNode("paragraph", undefined, h.parseInline(t.tokens))
      : (this.parent?.(t, h) ?? []);
  },
});
// 原样的 HTML：<u>、<kbd> 是格式，<br> 是硬换行；别的标签和注释一字不改地留着
// 行内的（<span style=…>字</span>：开头标签到配对的结尾标签算一个）是 htmlInline，单独成块的（<div>…</div>、<!-- … -->）是 htmlBlock。
// 显示的是清洗过的 HTML；注释不显示，编辑时显示成淡色的源码（看得见、删得掉）。打的字里的 < 照旧转义成 \<（是字，不是 HTML）
export const isHtmlComment = (raw: string) => /^\s*<!--[\s\S]*-->\s*$/.test(raw);
const htmlNode = (name: "htmlInline" | "htmlBlock", tag: "span" | "div") =>
  Node.create({
    name,
    ...(tag === "span" ? { group: "inline", inline: true } : { group: "block" }),
    atom: true,
    selectable: true,
    addAttributes: () => ({ raw: { default: "" } }),
    parseHTML: () => [{ tag: `${tag}[data-html]`, getAttrs: (e) => ({ raw: (e as HTMLElement).dataset.html ?? "" }) }],
    renderHTML: ({ node }) => [tag, { class: "md-html", "data-html": node.attrs.raw }],
    renderText: ({ node }) => node.attrs.raw,
    renderMarkdown: (n) => n.attrs?.raw ?? "",
    addNodeView:
      () =>
      ({ node }) => {
        const dom = document.createElement(tag);
        dom.className = "md-html";
        dom.contentEditable = "false";
        const html = isHtmlComment(node.attrs.raw) ? "" : DOMPurify.sanitize(node.attrs.raw);
        dom.innerHTML = html;
        if (!dom.textContent?.trim() && !dom.querySelector("img, svg, video, iframe")) {
          dom.textContent = node.attrs.raw;
          dom.classList.add("src");
        }
        return { dom, ignoreMutation: () => true };
      },
  });
// 一个标签（属性照 CommonMark 的写法）、一段注释
const TAG =
  /^(?:<!--[\s\S]*?-->|<\/?([A-Za-z][\w-]*)(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/;
/** 行内的 HTML 从开头认一段：开头标签连同配对的结尾标签（中间同名的嵌套也算上）是一段，别的一个标签、一段注释自己是一段。配好对的 <u>…</u>、<kbd>…</kbd> 是格式，不归这里 */
function htmlInlineAt(src: string): string | undefined {
  const m = TAG.exec(src);
  if (!m) return;
  const name = m[1]?.toLowerCase();
  if ((name === "u" || name === "kbd") && new RegExp(`^<${name}>[\\s\\S]+?</${name}>`).test(src)) return;
  if (!name || m[0].startsWith("</") || m[0].endsWith("/>")) return m[0];
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = m[0].length;
  for (let depth = 1, t: RegExpExecArray | null; (t = re.exec(src)); )
    if ((depth += t[1] ? -1 : 1) === 0) return src.slice(0, re.lastIndex);
  return m[0];
}
export const HtmlInline = htmlNode("htmlInline", "span").extend({
  markdownTokenName: "htmlInline",
  parseMarkdown: (t) => {
    const raw = t.raw ?? "";
    return /^<br\s*\/?>$/i.test(raw) ? { type: "hardBreak" } : { type: "htmlInline", attrs: { raw } };
  },
  markdownTokenizer: {
    name: "htmlInline",
    level: "inline",
    start: (src) => src.indexOf("<"),
    tokenize: (src) => {
      const raw = htmlInlineAt(src);
      return raw ? { type: "htmlInline", raw } : undefined;
    },
  },
});
export const HtmlBlock = htmlNode("htmlBlock", "div").extend({
  markdownTokenName: "html",
  parseMarkdown: (t) => {
    const raw = (t.text || t.raw || "").replace(/\s+$/, "");
    return raw.trim() ? { type: "htmlBlock", attrs: { raw } } : [];
  },
});

// 分隔线只在回车时变（--- 打完就变会和 YAML 头、setext 标题冲突；见 editor/typora.ts）
export const Hr = HorizontalRule.extend({ addInputRules: () => [] });
// 空的列表项只写记号（"2."、"-"、"- [ ]"），后面不留空格：写回时末尾的空白会被去掉，而 marked 把行尾带空格的 "- " 读成段落里的字
const bareEmpty = (n: JSONContent, md: string) => {
  const first = n.content?.[0];
  return first?.type === "paragraph" && !first.content?.length ? md.replace(/^([^\n]*?)[ \t]+(?=\n|$)/, "$1") : md;
};
export const Item = ListItem.extend({
  renderMarkdown(n, h, c) {
    return bareEmpty(n, String(this.parent?.(n, h, c) ?? ""));
  },
});
// 有序列表：分词交给 marked（见 NO_OL_TOKENIZER），列表项和无序列表一样由 listItem 解析（空的项给一个空段落）
export const Ordered = OrderedList.extend({
  markdownTokenizer: NO_OL_TOKENIZER,
  parseMarkdown: (t, h) =>
    t.type === "list" && t.ordered
      ? {
          type: "orderedList",
          ...(typeof t.start === "number" && t.start !== 1 ? { attrs: { start: t.start } } : {}),
          content: h.parseChildren(t.items ?? []),
        }
      : [],
});
// 勾选项：编辑器里是 TipTap 的节点视图（不带 data-type，样式靠这个属性，补上）；静态显示照 renderHTML，勾选框后面不要空的 span
export const Task = TaskItem.extend({
  renderHTML: ({ node, HTMLAttributes }) => [
    "li",
    mergeAttributes(HTMLAttributes, { "data-type": "taskItem" }),
    ["label", ["input", { type: "checkbox", checked: node.attrs.checked ? "checked" : null }]],
    ["div", 0],
  ],
  renderMarkdown(n, h, c) {
    return bareEmpty(n, String(this.parent?.(n, h, c) ?? ""));
  },
}).configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } });
// 勾选列表照 TipTap 的规则，只是空的勾选项（行里只有 "- [ ]"）也认
const TASK_ITEM = /^(\s*)([-+*])\s+\[([ xX])\](?:[ \t]+(.*))?$/;
const taskBlocks = (src: string, lx: Lexer) =>
  parseIndentedBlocks(
    src,
    {
      itemPattern: TASK_ITEM,
      extractItemData: (m) => ({
        indentLevel: m[1].length,
        mainContent: m[4] ?? "",
        checked: m[3].toLowerCase() === "x",
      }),
      createToken: (d, nestedTokens) => ({
        type: "taskItem",
        raw: "",
        mainContent: d.mainContent,
        indentLevel: d.indentLevel,
        checked: d.checked,
        text: d.mainContent,
        tokens: lx.inlineTokens(d.mainContent),
        nestedTokens,
      }),
      customNestedParser: (body) => {
        const r = taskBlocks(body, lx);
        if (!r) return lx.blockTokens(body);
        const rest = body.slice(r.raw.length);
        return [{ type: "taskList", raw: r.raw, items: r.items }, ...(rest.trim() ? lx.blockTokens(rest) : [])];
      },
    },
    lx,
  );
export const Tasks = TaskList.extend({
  markdownTokenizer: {
    name: "taskList",
    level: "block",
    start: (src) => src.match(/^\s*[-+*]\s+\[[ xX]\](?:[ \t]|$)/m)?.index ?? -1,
    tokenize: (src, _t, lx) => {
      const r = taskBlocks(src, lx);
      return r ? { type: "taskList", raw: r.raw, items: r.items } : undefined;
    },
  },
});
// 表格：GFM 存不下合并单元格和一格多段，所以一格只放一段
export const Cell = TableCell.extend({ content: "paragraph" });
// A table's caption is a paragraph "Table: …" right after it (Pandoc's table caption), read onto the table by parseMd
// (tableCaptions in schema.ts); the attribute holds the caption's inline Markdown
export const TABLE_CAPTION = /^Table:[ \t]+(?=\S)/;
export const Tbl = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), caption: { default: null, rendered: false } };
  },
  renderMarkdown(n, h, c) {
    const t = String(this.parent?.(n, h, c) ?? "").replace(/^\n+|\n+$/g, ""),
      cap = captionOf(n.attrs?.caption).replace(/\s*\n\s*/g, " ");
    return cap ? `${t}\n\nTable: ${cap}` : t;
  },
}).configure({ resizable: false });
export const Head = TableHeader.extend({ content: "paragraph" });
