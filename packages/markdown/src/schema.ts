// MarkdownManager 只建一个，用自己的 marked 实例（@tiptap/markdown 默认往全局 marked 上挂规则，建几个就叠几层，解析会越来越慢）。
import { getSchema, markInputRule, markPasteRule, type AnyExtension, type JSONContent } from "@tiptap/core";
import type { Attrs, Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Bold, { starPasteRegex } from "@tiptap/extension-bold";
import Italic, { underscoreInputRegex } from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import { MarkdownManager } from "@tiptap/markdown";
import { Marked, Tokenizer, type MarkedExtension, type marked } from "marked";
import { TableRow } from "@tiptap/extension-table";
import { bracketDelims, dollarBrackets } from "./brackets";
import {
  brokenImage,
  Cell,
  Code,
  Det,
  DetBody,
  DetSum,
  Doc,
  Emoji,
  FnDef,
  FnList,
  FnRef,
  Head,
  Hr,
  HtmlBlock,
  HtmlInline,
  Img,
  Item,
  Math1,
  Math2,
  Ordered,
  Para,
  Task,
  Tasks,
  TABLE_CAPTION,
  Tbl,
  Toc,
  WikiRef,
} from "./schema-nodes";
import { Annot, Highlight, InlineCode, Kbd, Lnk, outsideCode, Sub, Sup, U } from "./schema-marks";
import { ESC_DOLLAR, escText, markStarts } from "./schema-escape";
import { imageAttrsAt } from "./imageattrs";
import { markableLeaf, marksOnAtoms, SHIELD, shield, unshield } from "./tiptap-markdown-patch";

/** 两边共用的扩展（只含 schema 和 markdown 规则；编辑器专用的插件在 editor/ 里另加） */
export const baseExtensions: AnyExtension[] = [
  // 标注、高亮排在所有格式前面：它们是最外层的那一层，里面再有粗体、链接时底色也是连着的一整段（排在后面会被拆成几段）
  Annot,
  Highlight,
  StarterKit.configure({
    document: false,
    paragraph: false,
    codeBlock: false,
    underline: false,
    trailingNode: false,
    bold: false,
    italic: false,
    strike: false,
    horizontalRule: false,
    code: false,
    link: false,
    listItem: false,
    orderedList: false,
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // 拖图时的落点线：颜色在 markdown.css（.md-dropcursor，跟着主题）
    dropcursor: { color: false, width: 2, class: "md-dropcursor" },
  }),
  // 打字时的 **b** *i* ~~s~~ 不用 TipTap 自带的正则（要求开头记号前是空白：中文后面紧跟的 **粗体** 不变；整行的字连行内代码里的 ** 一起配对，
  // 会把代码里的记号吃掉），由编辑器按解析器重解析（editor/typora.ts 的 retype），和存回去再读进来的一样。
  // 粗体只认 **b**：__init__ 是代码里的名字（解析时 _ 也不当强调）；打 _i_ 照旧变斜体（存成 *i*），但不跨过行内代码
  Bold.extend({
    addInputRules: () => [],
    addPasteRules() {
      return [markPasteRule({ find: starPasteRegex, type: this.type })];
    },
  }),
  Italic.extend({
    addInputRules() {
      return [outsideCode(markInputRule({ find: underscoreInputRegex, type: this.type }))];
    },
  }),
  Strike.extend({ addInputRules: () => [] }),
  Lnk,
  U,
  Kbd,
  Hr,
  InlineCode,
  Sub,
  Sup,
  Toc,
  Item,
  Ordered,
  Doc,
  Para,
  Code,
  Tasks,
  Task,
  Img,
  Det,
  DetSum,
  DetBody,
  Math1,
  Math2,
  Tbl,
  TableRow,
  Head,
  Cell,
  WikiRef,
  Emoji,
  FnList,
  FnDef,
  FnRef,
  HtmlInline,
  HtmlBlock,
];

/**
 * The editor's schema: the same blocks, but paragraphs (headings and table cells included) hold Markdown source as
 * plain text, so there are no marks and no inline nodes (editor/inline.ts draws them). Footnote definitions are
 * paragraphs too. Layout that Markdown cannot hold lives in attributes: code block wrap, row height (column widths are
 * the cells' own colwidth); see layout.ts
 */
export const sourceExtensions: AnyExtension[] = [
  StarterKit.configure({
    document: false,
    paragraph: false,
    codeBlock: false,
    underline: false,
    trailingNode: false,
    bold: false,
    italic: false,
    strike: false,
    horizontalRule: false,
    code: false,
    link: false,
    listItem: false,
    orderedList: false,
    heading: false,
    hardBreak: false,
    dropcursor: { color: false, width: 2, class: "md-dropcursor" },
  }),
  Hr,
  Toc,
  Item,
  Ordered,
  Tasks,
  Task,
  Det,
  DetSum,
  DetBody,
  Math2,
  HtmlBlock,
  Document.extend({ content: "block+" }),
  Paragraph.extend({ marks: "" }),
  Code.extend({
    addAttributes() {
      return { ...this.parent?.(), wrap: { default: false, rendered: false } };
    },
  }),
  Tbl,
  TableRow.extend({
    addAttributes() {
      return {
        height: {
          default: null,
          renderHTML: (a) => (a.height ? { style: `height: ${a.height}px` } : {}),
          parseHTML: (e) => parseInt(e.style.height, 10) || null,
        },
      };
    },
  }),
  Head,
  Cell,
];

const mm = new MarkdownManager({
  marked: (() => {
    const m = new Marked();
    // _ 不当强调：__init__、block_manager 都是代码里的名字
    m.use({
      tokenizer: {
        emStrong(src: string) {
          return src[0] === "_" ? undefined : false;
        },
        // 图片后面紧跟的 {width=…% frame=… loop=true} 是它的属性（见 imageattrs.ts），连同图片一起读掉
        link(this: Tokenizer, src: string) {
          const t = Tokenizer.prototype.link.call(this, src) ?? brokenImage(src),
            a = t?.type === "image" ? imageAttrsAt(src.slice(t.raw.length)) : undefined;
          return a ? { ...t!, raw: t!.raw + a.raw, attrs: a.attrs } : (t ?? false);
        },
      } as MarkedExtension["tokenizer"],
    });
    // MarkdownManager is typed for the marked module; it only calls what an instance has too (lexer, parser, use)
    return m as unknown as typeof marked;
  })(),
  extensions: baseExtensions,
});
let schema: Schema | undefined;
export const mdSchema = () => (schema ??= getSchema(baseExtensions));
marksOnAtoms(mm, mdSchema);
const isMarkableLeaf = (type: string | undefined) => markableLeaf(mdSchema(), type);

/** 文档内容 → Markdown。raw：字原样写出（不转义），把一段当 Markdown 源码重新解析时用（见 blockSource） */
function toMd(content: JSONContent[], raw: boolean): string {
  const { nodes, marks } = mdSchema();
  const prep = (ns: JSONContent[], code: boolean): JSONContent[] =>
    ns.map((n, i) => {
      if (n.type === "text") {
        if (code || n.marks?.some((m) => marks[m.type]?.spec.code)) return n;
        // 标注里的字：{ } | 也要转义（它们会断开标注的写法）；紧跟在图片后面、会被读成它的属性的 {width=…%} 也转义
        let t = raw ? n.text! : escText(n.text!);
        if (!raw && ns[i - 1]?.type === "image" && imageAttrsAt(t)) t = `\\${t}`;
        return {
          ...n,
          text: shield(n.marks?.some((m) => m.type === "annot") && !raw ? t.replace(/(?<!\\)[{}|]/g, "\\$&") : t),
        };
      }
      // 带格式的行内原子节点：先写成它自己的 Markdown，当作带同样格式的字（不转义），格式的记号就包在它外面
      if (n.marks?.length && isMarkableLeaf(n.type))
        return {
          type: "text",
          text: shield(
            mm
              .serialize({ type: "doc", content: [{ type: "paragraph", content: [{ ...n, marks: undefined }] }] })
              .replace(/^\n+|\n+$/g, ""),
          ),
          marks: n.marks,
        };
      // 折叠块的标题由 details 自己写成 HTML 的字，不经过这里
      return n.content
        ? { ...n, content: prep(n.content, code || !!nodes[n.type!]?.spec.code || n.type === "detailsSummary") }
        : n;
    });
  return unshield(mm.serialize({ type: "doc", content: prep(content, false) }));
}

/** Markdown → 文档 JSON（脚注定义收到文末一个 footnotes 里，按引用顺序编号） */
export function parseMd(src: string): JSONContent {
  // 转义的 \$ 先换成占位字（解析器会把 \$ 和普通 $ 解成同一个字，后面就分不出哪个是转义过的），见 mathify / unDollar。
  // 链接地址 ](…) 和 <自动链接> 里不换（地址里的占位字会被当成非法字符丢掉）
  const doc = mm.parse(
    src
      .replace(/\r\n?/g, "\n")
      .replace(/(\]\([^)\n]*\)|<[^>\s]*>)|\\([\\$])/g, (m, url, c) => (!url && c === "$" ? ESC_DOLLAR : m)),
  );
  const defs = new Map<string, JSONContent>();
  const rest: JSONContent[] = [];
  for (const n of doc.content ?? [])
    if (n.type === "footnote") defs.set(n.attrs?.["data-id"], n);
    else rest.push(n);
  const refs: string[] = [];
  walk(rest, (n) => {
    if (n.type === "footnoteReference" && !refs.includes(n.attrs?.["data-id"])) refs.push(n.attrs?.["data-id"]);
  });
  if (refs.length) {
    walk(rest, (n) => {
      if (n.type === "footnoteReference")
        n.attrs = { ...n.attrs, referenceNumber: String(refs.indexOf(n.attrs?.["data-id"]) + 1) };
    });
    rest.push({
      type: "footnotes",
      content: refs.map((id, i) => ({
        type: "footnote",
        content: defs.get(id)?.content ?? [{ type: "paragraph" }],
        attrs: { "data-id": id, id: `fn:${i + 1}` },
      })),
    });
  }
  if (!rest.length) rest.push({ type: "paragraph" });
  return { type: "doc", content: tableCaptions(unDollar(mathify(rest)!)) };
}
/**
 * A paragraph "Table: …" right after a table becomes that table's caption (TABLE_CAPTION), at any depth. In a tight list item
 * the line comes as loose inline nodes, its text as written (not read for marks): that text is kept as it is
 */
function tableCaptions(ns: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i],
      prev = out[out.length - 1];
    if (prev?.type === "table" && !prev.attrs?.caption) {
      let src: string | null = null,
        end = i;
      if (n.type === "paragraph" && n.content?.[0]?.type === "text") src = inlineMd(n);
      else if (n.type === "text") {
        while (end + 1 < ns.length && mdSchema().nodes[ns[end + 1].type!]?.isInline) end++;
        src = ns
          .slice(i, end + 1)
          .map((k) => (k.type === "text" && !k.marks?.length ? k.text : inlineMd({ type: "paragraph", content: [k] })))
          .join("");
      }
      if (src !== null && TABLE_CAPTION.test(src)) {
        out[out.length - 1] = { ...prev, attrs: { ...prev.attrs, caption: src.replace(TABLE_CAPTION, "").trim() } };
        i = end;
        continue;
      }
    }
    out.push(n.content && !NO_TABLES.has(n.type!) ? { ...n, content: tableCaptions(n.content) } : n);
  }
  return out;
}
const NO_TABLES = new Set(["paragraph", "heading", "codeBlock", "table"]);
/**
 * 每个顶层块（parseMd 的 content，文末的脚注块不算）在 src 里从第几个字开始：往两块之间插一段 Markdown 时用（比如拖进来的图放在松手的那两块之间）。
 * 按 marked 的顶层分词：一个不是空行的词对应一块。对不上（多出来的空行读成了空段落、脚注定义、链接定义这些）就给 null
 */
export function mdBlockStarts(src: string): number[] | null {
  if (src.includes("\r")) return null;
  const mgr = mm as unknown as {
    createLexer(): { lex(s: string): { type: string; raw: string }[] };
    parse(s: string): JSONContent;
  };
  const toks = mgr.createLexer().lex(src);
  if (toks.reduce((n, t) => n + t.raw.length, 0) !== src.length) return null;
  const starts: number[] = [];
  let at = 0,
    prev = "";
  for (const t of toks) {
    // a table's caption line is part of the table's block (tableCaptions)
    const caption = prev === "table" && t.type === "paragraph" && TABLE_CAPTION.test(t.raw);
    if (t.type !== "space" && !caption) starts.push(at);
    if (t.type !== "space") prev = caption ? "" : t.type;
    at += t.raw.length;
  }
  const blocks = tableCaptions(mgr.parse(src).content ?? []);
  return blocks.length === starts.length && blocks.every((b) => b.type !== "footnote") ? starts : null;
}
/**
 * 粘贴的纯文字当不当 Markdown：交给解析器读一遍，读出了格式、块才算（给出读出来的文档），只是字给 null（照纯文字粘贴）。
 * 不算数的：光秃秃的网址（链接扩展自己处理，选着字粘贴网址是给字加链接）、上下标（中文里 3~5、7~9 这样的范围读出来就是下标）、
 * 缩进出来的代码块（排版里的缩进）。有别的格式时整段照 Markdown 读，它们也跟着变
 */
export function pastedMd(text: string): JSONContent | null {
  const doc = parseMd(texBrackets(text));
  let md = false,
    indented = false;
  const plainMark = (m: { type: string; attrs?: Attrs }, n: JSONContent) =>
    m.type === "subscript" ||
    m.type === "superscript" ||
    (m.type === "link" && !!n.text && String(m.attrs?.href ?? "").endsWith(n.text));
  walk(doc.content, (n) => {
    if (n.type === "codeBlock") indented = true;
    else if (!/^(paragraph|text|hardBreak)$/.test(n.type ?? "") || n.marks?.some((m) => !plainMark(m, n))) md = true;
  });
  if (!md && indented) {
    type Tok = { type: string; codeBlockStyle?: string; tokens?: Tok[]; items?: Tok[] };
    const fenced = (ts: Tok[]): boolean =>
      ts.some(
        (t) =>
          (t.type === "code" && t.codeBlockStyle !== "indented") || fenced(t.tokens ?? []) || fenced(t.items ?? []),
      );
    md = fenced(
      (mm as unknown as { createLexer(): { lex(s: string): Tok[] } }).createLexer().lex(text.replace(/\r\n?/g, "\n")),
    );
  }
  return md ? doc : null;
}
/**
 * 粘贴的 Markdown 里的 \( … \)、\[ … \] 写成 $…$、$$…$$（见 brackets.ts）；其余原样。哪个记号在代码、公式里由解析器定：
 * 记号先换成一个占位字再分词，按顺序数每个词里有几个，代码、行内代码、HTML、公式里的不算。数不齐（比如在链接地址里）就整段不动
 */
export function texBrackets(src: string): string {
  const ds = bracketDelims(src);
  if (!ds.length) return src;
  type Tok = { type?: string; raw?: string; tokens?: Tok[]; items?: Tok[]; header?: Tok[] | boolean; rows?: Tok[][] };
  let hidden = "",
    last = 0;
  for (const d of ds) {
    hidden += src.slice(last, d.at) + BRACKET;
    last = d.at + 2;
  }
  hidden += src.slice(last);
  const usable: boolean[] = [];
  const visit = (ts: Tok[] | undefined) => {
    for (const t of ts ?? []) {
      // 表格的 header 是一行格子；格子自己的 header 是 true/false（是不是表头格）
      const kids = [
        ...(t.tokens ?? []),
        ...(t.items ?? []),
        ...(Array.isArray(t.header) ? t.header : []),
        ...(t.rows ?? []).flat(),
      ];
      const lit = /^(code|codespan|html|inlineMath|blockMath)$/.test(t.type ?? "");
      if (kids.length && !lit) {
        visit(kids);
        continue;
      }
      for (const c of t.raw ?? "") if (c === BRACKET) usable.push(!lit);
    }
  };
  visit((mm as unknown as { createLexer(): { lex(s: string): Tok[] } }).createLexer().lex(hidden));
  return usable.length === ds.length ? dollarBrackets(src, (k) => usable[k]) : src;
}
const BRACKET = "";
function walk(ns: JSONContent[] | undefined, f: (n: JSONContent) => void) {
  for (const n of ns ?? []) {
    f(n);
    walk(n.content, f);
  }
}

export function serializeMd(doc: JSONContent): string {
  const content = [...(doc.content ?? [])];
  const fi = content.findIndex((n) => n.type === "footnotes");
  const fns = fi >= 0 ? content.splice(fi, 1)[0] : undefined;
  // 脚注按引用出现的顺序重新编号
  const num = new Map<string, number>();
  walk(content, (n) => {
    const id = n.attrs?.["data-id"];
    if (n.type === "footnoteReference" && !num.has(id)) num.set(id, num.size + 1);
  });
  const renumber = (ns: JSONContent[]): JSONContent[] =>
    ns.map((n) => {
      const k = n.type === "footnoteReference" ? num.get(n.attrs?.["data-id"]) : undefined;
      const m = k === undefined ? n : { ...n, attrs: { ...n.attrs, referenceNumber: String(k) } };
      return m.content ? { ...m, content: renumber(m.content) } : m;
    });
  let out = toMd(markStarts(dropEmpty(renumber(content))), false);
  // 还没写内容的脚注不写空定义（[^1] 读回来照样是脚注）
  const defs = (fns?.content ?? [])
    .filter((f) => num.has(f.attrs?.["data-id"]))
    .sort((a, b) => num.get(a.attrs!["data-id"])! - num.get(b.attrs!["data-id"])!)
    .map((f) => [num.get(f.attrs!["data-id"]), toMd(markStarts(renumber(f.content ?? [])), false).trim()] as const)
    .filter(([, body]) => body)
    .map(([k, body]) => `[^${k}]: ${body.replace(/\n/g, "\n    ")}`);
  if (defs.length) out = `${out.trimEnd()}\n\n${defs.join("\n")}`;
  return out.replace(/^\n+/, "").replace(/\s+$/, "");
}
/** 一段行内 Markdown 解析回行内内容；解析出来不是一段行内内容时给 null（粘贴进来的 HTML 里的字按 Markdown 读时用） */
export function parseSource(src: string, inline: boolean): JSONContent[] | null {
  return inline ? inlineParse(src) : (parseMd(src).content ?? []).filter((n) => n.type !== "footnotes");
}
const INLINE_HEAD = "";
const plain = (t: string): JSONContent[] => (t ? [{ type: "text", text: t }] : []);
/** 两头的空白照留（解析会去掉）。前面垫一个字，# - 1. > 之类不会被当成块 */
function inlineParse(src: string): JSONContent[] | null {
  const lead = /^\s*/.exec(src)![0],
    trail = src.slice(lead.length).match(/\s*$/)![0],
    core = src.slice(lead.length, src.length - trail.length);
  if (!core) return plain(src);
  const blocks = (parseMd(INLINE_HEAD + core).content ?? []).filter((n) => n.type !== "footnotes");
  const p = blocks[0],
    first = p?.content?.[0];
  if (blocks.length !== 1 || p.type !== "paragraph" || first?.type !== "text" || !first.text?.startsWith(INLINE_HEAD))
    return null;
  const rest = first.text.slice(INLINE_HEAD.length);
  return [...plain(lead), ...(rest ? [{ ...first, text: rest }] : []), ...p.content!.slice(1), ...plain(trail)];
}

// 编辑器的文档：段落（标题、格子里的那一段也是段落）里存的就是这一段的 Markdown 原文（editor/srcdoc.ts）。
// 读进来时每一段照 serializeMd 的规则写成原文；写出去时原文一字不改，只有块的结构交给 MarkdownManager 拼起来

/** 一段（段落、标题）的行内内容写成 Markdown 原文：和 serializeMd 写出来的一样，只是硬换行写成 <br>（Shift+↵ 打的也是它，编辑器里看得见） */
export function inlineMd(block: JSONContent): string {
  const content = block.content?.map((n) =>
    n.type === "hardBreak" ? { type: "htmlInline", attrs: { raw: "<br>" }, marks: n.marks } : n,
  );
  const b = { ...block, content };
  return toMd(block.type === "paragraph" ? markStarts([b]) : [b], false).replace(/^\n+|\n+$/g, "");
}
/** 几个块写成 Markdown（脚注定义的正文） */
export const blocksMd = (content: JSONContent[]) => toMd(markStarts(content), false).trim();
/** 编辑器文档的块写成 Markdown：段落里的原文原样写出。格子里的 | 写成 \|（GFM 的格子靠 | 断开；原文里已经写成 \| 的不再转义） */
export function sourceBlocksMd(content: JSONContent[]): string {
  const prep = (ns: JSONContent[], cell: boolean): JSONContent[] =>
    ns.map((n) => {
      if (n.type === "paragraph") {
        const t = (n.content ?? []).map((c) => c.text ?? "").join("");
        return { ...n, content: t ? [{ type: "text", text: cell ? shieldCell(t) : shield(t) }] : undefined };
      }
      if (!n.content || mdSchema().nodes[n.type!]?.spec.code || n.type === "detailsSummary") return n;
      return { ...n, content: prep(n.content, cell || n.type === "tableCell" || n.type === "tableHeader") };
    });
  return unshield(mm.serialize({ type: "doc", content: prep(dropEmpty(content), false) }))
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}
const shieldCell = (t: string) =>
  shield(t.replace(/\\.|\|/g, (m) => (m === "|" ? "\\|" : m))).replace(/\|/g, (c) =>
    String.fromCharCode(SHIELD + c.charCodeAt(0)),
  );

export type InlineToken = {
  type: string;
  raw: string;
  text?: string;
  tokens?: InlineToken[];
  href?: string;
  title?: string | null;
  [k: string]: unknown;
};
let lexer: { inlineTokens(src: string): InlineToken[] } | undefined;
/** 一段行内原文按解析器分词（和 parseMd 读一段时是同一套规则）：编辑器照它画格式 */
export function inlineTokens(src: string): InlineToken[] {
  lexer ??= (mm as unknown as { createLexer(): { inlineTokens(src: string): InlineToken[] } }).createLexer();
  return lexer.inlineTokens(src);
}

// 字里看着像 $公式$ 的（Pandoc 规则，和 INLINE_MATH 一样）变成公式：两头都是没转义的 $。转义过的 \$ 总是字面的 $（Typora 一样）：
// \$x$、\$x\$ 都是普通文字（打 $x$ 变成公式后 ⌘Z 撤回的就存成 \$x$）
export const TEXT_MATH = /(^|[^$\\\uE024])\$([^$\s\uE024](?:[^$\uE024]*[^$\s\\\uE024])?)\$(?![\d$\uE024])/g;
/** 占位字换回去：正文、链接地址里是 $；代码、公式源码、原样的 HTML 里原样是 \$ */
function unDollar(ns: JSONContent[], raw = false): JSONContent[] {
  const fix = (t: string, r: boolean) => (t.includes(ESC_DOLLAR) ? t.replaceAll(ESC_DOLLAR, r ? "\\$" : "$") : t);
  return ns.map((n) => {
    const r = raw || n.type === "codeBlock" || n.type === "htmlInline" || n.type === "htmlBlock";
    const out: JSONContent = { ...n };
    if (n.text !== undefined) out.text = fix(n.text, r || (n.marks ?? []).some((m) => m.type === "code"));
    if (n.attrs)
      out.attrs = Object.fromEntries(
        Object.entries(n.attrs).map(([k, v]) => [k, typeof v === "string" ? fix(v, r || k === "latex") : v]),
      );
    if (n.content) out.content = unDollar(n.content, r);
    return out;
  });
}
function mathify(ns: JSONContent[] | undefined): JSONContent[] | undefined {
  if (!ns) return ns;
  const out: JSONContent[] = [];
  for (const n of ns) {
    if (n.type === "codeBlock") {
      out.push(n);
      continue;
    }
    if (n.type === "text" && n.text?.includes("$") && !(n.marks ?? []).some((m) => m.type === "code")) {
      let last = 0,
        m: RegExpExecArray | null;
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

// 空段落写不进 Markdown（TipTap 会写成多余的空行或 &nbsp;）：写回时去掉；表格格子里的、容器里唯一的一段留着。
// 夹在两个列表中间的留着，每个写成一行 &nbsp;（TipTap 的空段落写法，读回来还是空段落；TipTap 自己只给连着的第二个起写它）：
// 去掉的话两个列表读回来就连成一个，编号也接着上一个排了
const HOLDS = new Set(["blockquote", "listItem", "taskItem", "detailsContent", "footnote"]);
const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
const NBSP: JSONContent = { type: "htmlBlock", attrs: { raw: "&nbsp;" } };
const isEmptyP = (n: JSONContent | undefined) => n?.type === "paragraph" && !n.content?.length;
function betweenLists(ns: JSONContent[], i: number) {
  let a = i,
    b = i;
  while (isEmptyP(ns[a])) a--;
  while (isEmptyP(ns[b])) b++;
  return LISTS.has(ns[a]?.type ?? "") && LISTS.has(ns[b]?.type ?? "");
}
function dropEmpty(ns: JSONContent[], holder = true): JSONContent[] {
  const kept = holder ? ns.flatMap((n, i) => (!isEmptyP(n) ? [n] : betweenLists(ns, i) ? [NBSP] : [])) : ns;
  return (kept.length ? kept : ns.slice(0, 1)).map((n) =>
    n.content && n.type !== "paragraph" ? { ...n, content: dropEmpty(n.content, HOLDS.has(n.type!)) } : n,
  );
}
