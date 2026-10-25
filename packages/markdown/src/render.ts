// 静态显示：Markdown → 文档（同一套 schema）→ HTML 字符串，不建编辑器、不建 DOM。按内容缓存，重画、缩放都不再解析。
// 每个节点、格式的 HTML 就是它扩展的 renderHTML（和编辑器 getHTML 一样，见单元测试 render.test.ts）；
// 显示时要不一样的只有下面 DISPLAY / DISPLAY_MARKS 里的几种
import type { DOMOutputSpec, Fragment, Mark, Node as PMNode } from "@tiptap/pm/model";
import katex from "katex";
import DOMPurify from "dompurify";
import { isHtmlComment, mdSchema, parseMd, tocEntries, tocHtml } from "./schema";
import { imageAttrs, onImagesChanged } from "./image";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const VOID = new Set(["img", "br", "hr", "input", "col", "wbr"]);

/** renderHTML 给的 DOMOutputSpec → HTML；hole 是内容（spec 里 0 的位置） */
function specHtml(spec: DOMOutputSpec, hole: string): string {
  if (typeof spec === "string") return esc(spec);
  if (!Array.isArray(spec)) throw new Error("static render: renderHTML returned a DOM node");
  const [tag, ...rest] = spec as readonly [string, ...unknown[]];
  let attrs = "", i = 0;
  const a = rest[0];
  if (a && typeof a === "object" && !Array.isArray(a)) {
    i = 1;
    for (const [k, v] of Object.entries(a)) if (v != null) attrs += ` ${k}="${escA(String(v))}"`;
  }
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  let inner = "";
  for (; i < rest.length; i++) inner += rest[i] === 0 ? hole : specHtml(rest[i] as DOMOutputSpec, hole);
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** 一次渲染的上下文：文档（目录要它的标题）、不过 DOMPurify 的可信 HTML（KaTeX 生成的，很大；Mermaid 的占位。字都转义过） */
type Cx = { doc: PMNode; trusted: string[] };
const trust = (cx: Cx, html: string) => `<span data-cbr="${cx.trusted.push(html) - 1}"></span>`;
const untrust = (html: string, t: string[]) => html.replace(/<span data-cbr="(\d+)"><\/span>/g, (_, i) => t[+i] ?? "");
function tex(cx: Cx, src: string, display: boolean) {
  try { return trust(cx, katex.renderToString(src, { displayMode: display, throwOnError: false, output: "html" })); }
  catch { return `<code>${esc(src)}</code>`; }
}

// 图片地址由用的一方解析（image.ts）：解析换了全部重画；一张图加载完学到了大小，带着它的那几篇重画（下次画时先留好位置）
onImagesChanged((raw) => {
  if (raw === undefined) return cache.clear();
  for (const k of [...cache.keys()]) if (k.includes(raw)) cache.delete(k);
});

/** Note 里原样写着的 HTML：注释不显示；其余照放，整篇最后过 DOMPurify */
const userHtml = (h: string) => (isHtmlComment(h) ? "" : h);

/** 显示时和 renderHTML 不一样的节点：编辑器里它们是节点视图，或者显示时要交给用的一方（返回 undefined 照 renderHTML） */
const DISPLAY: Record<string, (n: PMNode, cx: Cx) => string | undefined> = {
  // 公式：静态的 KaTeX（行内的不再包一层 span，少一个节点）
  inlineMath: (n, cx) => tex(cx, n.attrs.latex, !!n.attrs.display),
  blockMath: (n, cx) => `<div class="math" data-latex="${escA(n.attrs.latex)}">${tex(cx, n.attrs.latex, true)}</div>`,
  // Mermaid：先放源码，挂到页面上以后换成图（diagram.ts）。源码里常有 -->，DOMPurify 会删掉带它的属性：自己转义过，不过 DOMPurify
  codeBlock: (n, cx) => (n.attrs.language === "mermaid" ? trust(cx, `<div class="mmd" data-src="${escA(n.textContent)}"><pre class="md-code"><code>${esc(n.textContent)}</code></pre></div>`) : undefined),
  // 目录：填上这篇的标题
  toc: (_n, cx) => `<nav data-type="toc" class="md-toc">${tocHtml(tocEntries(cx.doc))}</nav>`,
  // 图片：地址、大小交给用的一方解析（和编辑器的节点视图同一份属性）；不让浏览器拖图（拖的是卡片）
  image: (n) => specHtml(["img", { ...imageAttrs(n.attrs), draggable: "false" }], ""),
  // 一条定义都还没写（只有正文里的 [^1]）：不画空的脚注列表
  footnotes: (n) => (n.content.content.some((f) => f.childCount > 1 || f.firstChild!.content.size > 0) ? undefined : ""),
  // 原样的 HTML：显示它本身（编辑器里是节点视图）
  htmlInline: (n) => userHtml(n.attrs.raw),
  htmlBlock: (n) => { const h = userHtml(n.attrs.raw); return h && `<div class="md-html">${h}</div>`; },
};
/** 显示时不一样的格式：链接不放 href，点了由 mdClick 交给用的一方打开（白板交给宿主），webview 自己不跳转 */
const DISPLAY_MARKS: Record<string, (m: Mark) => DOMOutputSpec> = {
  link: (m) => ["a", { class: "lnk", "data-href": m.attrs.href }, 0],
};
/** 只有一段（非空）的列表项、脚注、表格格子不画那层 <p>：外观一样（它本来就没有边距），一大块白板上少画一些节点 */
const SLIM = new Set(["listItem", "footnote", "tableCell", "tableHeader"]);

function markParts(m: Mark, display: boolean): [string, string] {
  const spec = (display && DISPLAY_MARKS[m.type.name]?.(m)) || m.type.spec.toDOM!(m, true);
  const h = specHtml(spec, "\0"), i = h.indexOf("\0");
  return [h.slice(0, i), h.slice(i + 1)];
}
function inlineHtml(f: Fragment, cx: Cx | null): string {
  let out = "";
  const open: { m: Mark; close: string }[] = [];
  f.forEach((n) => {
    let keep = 0;
    while (keep < open.length && keep < n.marks.length && open[keep].m.eq(n.marks[keep])) keep++;
    while (open.length > keep) out += open.pop()!.close;
    for (const m of n.marks.slice(keep)) { const [a, b] = markParts(m, !!cx); out += a; open.push({ m, close: b }); }
    out += nodeHtml(n, cx);
  });
  while (open.length) out += open.pop()!.close;
  return out;
}
function nodeHtml(n: PMNode, cx: Cx | null): string {
  if (n.isText) return esc(n.text!);
  const d = cx && DISPLAY[n.type.name]?.(n, cx);
  if (d != null) return d;
  return specHtml(n.type.spec.toDOM!(n), contentHtml(n, cx));
}
function contentHtml(n: PMNode, cx: Cx | null): string {
  if (n.inlineContent) return inlineHtml(n.content, cx);
  const one = n.childCount === 1 ? n.firstChild! : null;
  if (cx && one && SLIM.has(n.type.name) && one.type.name === "paragraph" && one.content.size) return inlineHtml(one.content, cx);
  let s = "";
  n.forEach((c) => { s += nodeHtml(c, cx); });
  return s;
}
/** 文档内容照 renderHTML 原样渲染（不带显示时的那几处不同）：和编辑器的 getHTML 对照用 */
export const schemaHtml = (doc: PMNode) => contentHtml(doc, null);

/** 渲染出来的 HTML，按内容缓存（最多 4000 条，超了按插入顺序丢最早的） */
const cache = new Map<string, string>();
const MAX = 4000;
export function renderMd(src: string): string {
  let h = cache.get(src);
  if (h !== undefined) return h;
  h = render(src);
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(src, h);
  return h;
}
export const clearMdCache = () => cache.clear();
export const mdCached = (src: string) => cache.has(src);

function render(src: string): string {
  if (!src.trim()) return "";
  let html: string, trusted: string[] = [];
  try {
    const doc = mdSchema().nodeFromJSON(parseMd(src));
    const cx: Cx = { doc, trusted };
    html = contentHtml(doc, cx);
  } catch (e) {
    console.warn("markdown render failed", e);
    html = `<p>${esc(src)}</p>`;
    trusted = [];
  }
  return untrust(purify(html), trusted);
}
// 生成的 HTML 来自 schema 和 Note 里原样写着的 HTML（htmlInline / htmlBlock）：整篇过一遍 DOMPurify
// 自己一个实例，配置只设一次：每次都传配置，DOMPurify 每次都要重新解析一遍（setConfig 是整个实例的，别影响贴纸那边）
let purifier: ReturnType<typeof DOMPurify> | undefined;
function purify(html: string) {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.setConfig({ ADD_ATTR: ["data-href", "data-latex", "data-src", "data-cardref", "data-lang", "data-type", "data-checked", "data-display", "data-cbr"] });
  }
  return purifier.sanitize(html);
}

/** 单行的说明（代码里的行内备注）：只要行内格式，整段放在一个 span 里 */
export function renderMdInline(src: string): string {
  const h = renderMd(src);
  // 只有一段时去掉 <p>，别的照块渲染
  const m = /^<p>([\s\S]*)<\/p>$/.exec(h);
  return m && !m[1].includes("<p>") ? m[1] : h;
}
