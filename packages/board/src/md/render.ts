// 静态显示：Markdown → 文档（同一套 schema）→ HTML 字符串，不建编辑器。按内容缓存，重画、缩放都不再解析。
// 用一个只拼字符串的假 document 跑 ProseMirror 的 DOMSerializer：结构和编辑器里一样，又不用真的建 DOM 再读 innerHTML
import { getSchema } from "@tiptap/core";
import { DOMSerializer, Node as PMNode, type Schema } from "@tiptap/pm/model";
import katex from "katex";
import DOMPurify from "dompurify";
import { baseExtensions, parseMd, tocEntries, tocHtml } from "./schema";
import { highlight } from "./hl";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const VOID = new Set(["img", "br", "hr", "input", "col", "wbr"]);

// ---------- 只拼字符串的假 DOM ----------
type FNode = FEl | FText | FFrag;
class FText { nodeType = 3; constructor(public text: string) {} html() { return esc(this.text); } }
class FFrag {
  nodeType = 11; kids: FNode[] = [];
  appendChild(c: FNode) { this.kids.push(c); return c; }
  html(): string { let s = ""; for (const k of this.kids) s += k.html(); return s; }
}
class FEl extends FFrag {
  nodeType = 1; attrs = "";
  constructor(public tag: string, public raw?: string) { super(); }
  setAttribute(k: string, v: string) { this.attrs += ` ${k}="${escA(String(v))}"`; }
  setAttributeNS(_ns: string, k: string, v: string) { this.setAttribute(k, v); }
  html(): string {
    if (this.raw !== undefined) return this.raw;
    const open = `<${this.tag}${this.attrs}>`;
    return VOID.has(this.tag) ? open : `${open}${super.html()}</${this.tag}>`;
  }
}
const fdoc = {
  createElement: (t: string) => new FEl(t),
  createElementNS: (_ns: string, t: string) => new FEl(t),
  createTextNode: (t: string) => new FText(t),
  createDocumentFragment: () => new FFrag(),
};
/** 一段现成的 HTML 当一个元素插进去 */
const raw = (html: string) => new FEl("", html) as unknown as HTMLElement;

// KaTeX 和高亮自己生成的 HTML 很大，又是可信的（字都转义过）：先换成占位符，只让 DOMPurify 过其余部分，最后再填回去
let trusted: string[] = [];
const trust = (html: string) => `<span data-cbr="${trusted.push(html) - 1}"></span>`;
const untrust = (html: string, t: string[]) => html.replace(/<span data-cbr="(\d+)"><\/span>/g, (_, i) => t[+i] ?? "");

function tex(src: string, display: boolean) {
  try { return trust(katex.renderToString(src, { displayMode: display, throwOnError: false, output: "html" })); }
  catch { return `<code>${esc(src)}</code>`; }
}

/** 图片地址：assets/ 开头的是白板自己的资源目录（宿主给 webview 地址） */
let assetBase = "";
export const setAssetBase = (b: string) => { if (b !== assetBase) { assetBase = b; cache.clear(); } };
const assetUrl = (src: string) => (/^assets\//.test(src) && assetBase ? `${assetBase}/${src.slice(7)}` : src);

let schema: Schema | undefined, ser: DOMSerializer | undefined;
function serializer() {
  if (ser) return ser;
  schema = getSchema(baseExtensions);
  const nodes = DOMSerializer.nodesFromSchema(schema), marks = DOMSerializer.marksFromSchema(schema);
  ser = new DOMSerializer({
    ...nodes,
    inlineMath: (n) => raw(tex(n.attrs.latex, !!n.attrs.display)), // 不再包一层 span：静态显示里没人用它，少一个节点
    blockMath: (n) => raw(`<div class="math" data-latex="${escA(n.attrs.latex)}">${tex(n.attrs.latex, true)}</div>`),
    codeBlock: (n) => {
      const lang = n.attrs.language as string | null;
      // Mermaid：先放源码，挂到页面上以后再换成图（mermaid 用到时才加载）
      if (lang === "mermaid") return raw(`<div class="mmd" data-src="${escA(n.textContent)}"><pre class="md-code"><code>${esc(n.textContent)}</code></pre></div>`);
      return raw(`<pre class="md-code"${lang ? ` data-lang="${escA(lang)}"` : ""}><code>${trust(highlight(n.textContent, lang))}</code></pre>`);
    },
    cardRef: (n) => raw(`<span class="cref" data-cardref="${escA(n.attrs.label)}">${esc(n.attrs.label)}</span>`),
    footnoteReference: (n) => raw(`<sup class="fnref">${esc(String(n.attrs.referenceNumber ?? "?"))}</sup>`),
    footnotes: () => ["ol", { class: "footnotes" }, 0],
    footnote: () => ["li", 0],
    image: (n) => ["img", { src: assetUrl(n.attrs.src ?? ""), alt: n.attrs.alt ?? "", title: n.attrs.title ?? null, draggable: "false" }],
  }, {
    ...marks,
    // 链接不放 href：点了由白板交给宿主打开（A.openLink），webview 自己不跳转
    link: (m) => ["a", { class: "lnk", "data-href": m.attrs.href }, 0],
  });
  return ser;
}

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
  let html: string;
  const t = (trusted = []);
  try {
    const s = serializer();
    const doc = PMNode.fromJSON(schema!, parseMd(src));
    html = slim((s.serializeFragment(doc.content, { document: fdoc as unknown as Document }) as unknown as FFrag).html());
    // [toc]：填上这篇的标题
    if (html.includes('data-type="toc"')) { const t = tocHtml(tocEntries(doc)); html = html.replace(/(<nav[^>]*data-type="toc"[^>]*>)<\/nav>/g, (_m, open: string) => `${open}${t}</nav>`); } // 函数替换：标题里的 $1、$& 不能当替换记号
  } catch (e) {
    console.warn("markdown render failed", e);
    html = `<p>${esc(src)}</p>`;
  }
  return untrust(typeof window === "undefined" ? html : purify(html), t);
}
// 少画一些节点（一大块白板上的 Note 平移、缩放时都要重画）：外观不变。
// 列表项、表格格子里只有一段（非空）时去掉那层 <p>（它本来就没有边距）；勾选框后面的空 <span> 不要；
// 勾选项里只有一段时，文字直接放在那个 div 里（div.t，划掉的样式也认它）
const SLIM_CELL = /<(li|th|td)><p>((?:(?!<\/?p[\s>]).)+?)<\/p><\/\1>/gs;
const SLIM_TASK = /<\/label><div><p>((?:(?!<\/?p[\s>]).)+?)<\/p><\/div>/gs;
function slim(h: string) {
  return h.replace(SLIM_CELL, "<$1>$2</$1>").replace(SLIM_TASK, '</label><div class="t">$1</div>').replace(/<span><\/span><\/label>/g, "</label>");
}
// 生成的 HTML 只来自 schema（原始 HTML 在解析时已经变成节点或纯文字），再过一遍 DOMPurify 兜底
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
