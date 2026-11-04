// The marks (inline formatting) of the Markdown schema with their Markdown rules
import { Mark, mergeAttributes, InputRule, type JSONContent } from "@tiptap/core";
import type {
  MarkdownLexerConfiguration as Lexer,
  MarkdownParseHelpers as ParseH,
  MarkdownRendererHelpers as RenderH,
  MarkdownToken as Token,
} from "@tiptap/core";
import type { Attrs } from "@tiptap/pm/model";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import CodeMark from "@tiptap/extension-code";
import { unshield } from "./tiptap-markdown-patch";

// 行内格式的 Markdown 记号：唯一的一份（写回、光标处显示的记号、展开成原文都按它）
// bold / italic / strike / code / link 的写回是 TipTap 自带的（和这里的记号一样），其余的写回用这张表
const MARK_MD: Record<string, (attrs: Attrs) => readonly [string, string]> = {
  bold: () => ["**", "**"],
  italic: () => ["*", "*"],
  strike: () => ["~~", "~~"],
  code: () => ["`", "`"],
  link: (a) => ["[", `](${a.href ?? ""})`],
  underline: () => ["<u>", "</u>"],
  kbd: () => ["<kbd>", "</kbd>"],
  highlight: () => ["==", "=="],
  subscript: () => ["~", "~"],
  superscript: () => ["^", "^"],
  annot: (a) => ["{", `|${escAnnot(a.note ?? "")}${annotOpts(a)}}`],
};
/**
 * 自己定义的格式的 Markdown 规则：re 从开头认一段（第 1 组是里面的字），记号来自 MARK_MD。
 * 打字时的转换不另写规则：编辑器照这里的解析重解析（editor/typora.ts）
 */
function mdSyntax(name: string, re: RegExp) {
  const [open, close] = MARK_MD[name]({}),
    tok = `x_${name}`;
  return {
    markdownTokenName: tok,
    parseMarkdown: (t: Token, h: ParseH) => h.applyMark(name, h.parseInline(t.tokens ?? [])),
    renderMarkdown: (n: JSONContent, h: RenderH) => `${open}${h.renderChildren(n)}${close}`,
    markdownTokenizer: {
      name: tok,
      level: "inline" as const,
      start: (src: string) => src.indexOf(open),
      tokenize: (src: string, prev: Token[], lx: Lexer) => {
        // 紧跟在同样的记号后面的不开头（~~ 是删除线；==、^ 同理）
        if (prev[prev.length - 1]?.raw?.endsWith(open[0])) return;
        const m = re.exec(src);
        return m ? { type: tok, raw: m[0], tokens: lx.inlineTokens(m[1]) } : undefined;
      },
    },
  };
}
export const U = Underline.extend(mdSyntax("underline", /^<u>([\s\S]+?)<\/u>/));
export const Kbd = Mark.create({
  name: "kbd",
  excludes: "_",
  parseHTML: () => [{ tag: "kbd" }],
  renderHTML: ({ HTMLAttributes }) => ["kbd", HTMLAttributes, 0],
  ...mdSyntax("kbd", /^<kbd>([\s\S]+?)<\/kbd>/),
});
// 下标、上标照 Pandoc：中间不能有空白（要空白写 \ ），~ 只有一个（~~ 是删除线）；高亮 == 里两头不是空白
const SUB_RE = /^~(?!~)((?:\\.|[^~\s\\])+)~(?!~)/;
export const SUP_RE = /^\^((?:\\.|[^\^\s\\])+)\^/,
  HL_RE = /^==(?=[^\s=])((?:\\.|[^\n\\])*?[^\s\\])==/;
const tagMark = (name: string, tag: string, re: RegExp) =>
  Mark.create({
    name,
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
    ...mdSyntax(name, re),
  });
export const Highlight = tagMark("highlight", "mark", HL_RE);

// {字|批注}、{字|批注|purple below}：贴在字上的手写标注（注音 ruby 的写法）
// 和 ==高亮== 是两回事，各用各的记号。第三段可选：颜色（blue purple orange green，默认 blue）和 below（标签写在字下面）。
// 字和批注里的 { } | \ 可以写成 \{ \} \| \\；成对的 { } 不用转义（公式 $\frac{a}{b}$ 照写），成对的括号里的 | 也不分段。
// 表格里 | 本来就要写成 \|。别的 Markdown 查看器里它原样显示成 {字|批注}，字不会丢
const ANNOT_COLORS = ["blue", "purple", "orange", "green"] as const;
const ANNOT_OPTS = /^\|([a-z ]*)\}/;
/** One part of an annotation from i: up to the | or } that ends it outside any { } pair; null: the line or the source ends first */
function annotPart(s: string, i: number): { end: number; by: string } | null {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") return null;
    if (c === "\\") {
      if (s[i + 1] === "\n") return null;
      i++;
    } else if (c === "{") depth++;
    else if (c === "}" && depth) depth--;
    else if ((c === "}" || c === "|") && !depth) return { end: i, by: c };
  }
  return null;
}
/** The {text|note|options} at the start of s: its parts as written (still escaped) and its length; null: none there */
export function annotAt(s: string): { text: string; note: string; opts: string; len: number } | null {
  if (s[0] !== "{") return null;
  const a = annotPart(s, 1);
  if (!a || a.by !== "|" || a.end === 1) return null;
  const b = annotPart(s, a.end + 1);
  if (!b || b.end === a.end + 1) return null;
  const text = s.slice(1, a.end),
    note = s.slice(a.end + 1, b.end);
  if (b.by === "}") return { text, note, opts: "", len: b.end + 1 };
  const o = ANNOT_OPTS.exec(s.slice(b.end));
  return o ? { text, note, opts: o[1], len: b.end + o[0].length } : null;
}
/**
 * A note as written in {text|note}: \ before { } | \ (or at the end) is doubled, any other \ stays as it is (\frac); { } stay
 * when they pair up (a formula reads as typed), else every one is escaped; | is always escaped (a table cell would split on it)
 */
export function escAnnot(t: string): string {
  let depth = 0,
    paired = true;
  for (const c of t) {
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) paired = false;
  }
  paired &&= depth === 0;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\") {
      const n = t[i + 1];
      if (n === undefined || "\\{}|".includes(n)) out += "\\\\";
      else {
        out += c + n;
        i++;
      }
    } else if (c === "|" || ((c === "{" || c === "}") && !paired)) out += `\\${c}`;
    else out += c;
  }
  return out;
}
const annotOpts = (a: Attrs) => {
  const o = [a.color && a.color !== "blue" ? a.color : "", a.below ? "below" : ""].filter(Boolean).join(" ");
  return o ? `|${o}` : "";
};
export const Annot = Mark.create({
  name: "annot",
  inclusive: false,
  addAttributes() {
    return {
      note: {
        default: "",
        parseHTML: (e) => e.getAttribute("data-note") ?? "",
        renderHTML: (a) => ({ "data-note": a.note }),
      },
      color: {
        default: "blue",
        parseHTML: (e) => e.getAttribute("data-color") ?? "blue",
        renderHTML: (a) => (a.color && a.color !== "blue" ? { "data-color": a.color } : {}),
      },
      below: {
        default: false,
        parseHTML: (e) => e.hasAttribute("data-below"),
        renderHTML: (a) => (a.below ? { "data-below": "" } : {}),
      },
    };
  },
  // 显示出来的标签（.md-annot-n）是批注属性画的，复制回来时不是字
  parseHTML: () => [{ tag: "span.md-annot-n", ignore: true }, { tag: "span.md-annot" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "md-annot" }), 0],
  markdownTokenName: "x_annot",
  parseMarkdown: (t: Token, h: ParseH) =>
    h.applyMark("annot", h.parseInline(t.tokens ?? []), { note: t.note, color: t.color, below: t.below }),
  renderMarkdown: (n: JSONContent, h: RenderH) => {
    const [a, b] = MARK_MD.annot(n.attrs ?? {});
    return `${a}${h.renderChildren(n)}${b}`;
  },
  markdownTokenizer: {
    name: "x_annot",
    level: "inline",
    start: (src: string) => src.indexOf("{"),
    tokenize: (src: string, _prev: unknown, lx: Lexer) => {
      const m = annotAt(src);
      if (!m) return;
      const un = (t: string) => t.replace(/\\([\\{}|])/g, "$1"),
        opts = m.opts.split(/\s+/);
      return {
        type: "x_annot",
        raw: src.slice(0, m.len),
        // where the text ends in raw (the editor shows the text and hides the rest)
        textEnd: 1 + m.text.length,
        tokens: lx.inlineTokens(un(m.text)),
        note: un(m.note).trim(),
        color: ANNOT_COLORS.find((c) => opts.includes(c)) ?? "blue",
        below: opts.includes("below"),
      };
    },
  },
});
export const Sub = tagMark("subscript", "sub", SUB_RE);
export const Sup = tagMark("superscript", "sup", SUP_RE);
// 行内代码的打字规则在 editor/typora.ts（反引号按长度配对）
export const InlineCode = CodeMark.extend({ addInputRules: () => [] });
// 链接：文字就是网址的写回裸网址（自动链接），不写成 [url](url)
export const Lnk = Link.extend({
  renderMarkdown(n, h, c) {
    const href = n.attrs?.href ?? "";
    if (unshield(c.meta?.markText ?? "") === href && /^https?:\/\/\S+$/.test(href)) return h.renderChildren(n);
    return this.parent?.(n, h, c) ?? "";
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  HTMLAttributes: { class: "md-link", rel: null, target: null },
});

/** 打字规则：匹配到的那一段里有行内代码时不算（规则的正则看的是整行的字，代码里的记号也在里面） */
export const outsideCode = (r: InputRule) =>
  new InputRule({
    find: r.find,
    undoable: r.undoable,
    handler: (p) =>
      p.state.doc.rangeHasMark(p.range.from, p.range.to, p.state.schema.marks.code) ? null : r.handler(p),
  });
