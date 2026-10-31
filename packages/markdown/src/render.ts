// Markdown → 文档 → HTML 字符串，不建编辑器、不建 DOM。每个节点、格式的 HTML 就是它的 renderHTML（和编辑器的 getHTML 一样），
// 显示时要不一样的只有 DISPLAY / DISPLAY_MARKS 里的几种
import { Fragment, type DOMOutputSpec, type Mark, type Node as PMNode } from "@tiptap/pm/model";
import katex from "katex";
import DOMPurify from "dompurify";
import { isHtmlComment, mdSchema, parseMd, tocEntries, tocHtml } from "./schema";
import { captionOf, imageAttrs, missingImageHtml, onImagesChanged } from "./image";
import { mathMacros, withTex } from "./math";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const VOID = new Set(["img", "br", "hr", "input", "col", "wbr"]);

/** hole 是内容（spec 里 0 的位置） */
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

/** trusted：不过 DOMPurify 的 HTML（KaTeX 生成的，很大；Mermaid 的占位。字都转义过） */
type Cx = { doc: PMNode; trusted: string[] };
const trust = (cx: Cx, html: string) => `<span data-cbr="${cx.trusted.push(html) - 1}"></span>`;
const untrust = (html: string, t: string[]) => html.replace(/<span data-cbr="(\d+)"><\/span>/g, (_, i) => t[+i] ?? "");
function tex(cx: Cx, src: string, display: boolean) {
  try { return trust(cx, withTex(katex.renderToString(src, { displayMode: display, throwOnError: false, output: "html", macros: mathMacros() }), src)); }
  catch { return `<code>${esc(src)}</code>`; }
}

// 解析换了全部重画；一张图学到了大小，带着它的那几篇重画（下次画时先留好位置）
onImagesChanged((raw) => {
  if (raw === undefined) return cache.clear();
  for (const k of [...cache.keys()]) if (k.includes(raw)) cache.delete(k);
});

/** 原样写着的 HTML：注释不显示；其余照放，整篇最后过 DOMPurify */
const userHtml = (h: string) => (isHtmlComment(h) ? "" : h);

/** 编辑器里是节点视图、或者显示时要交给用的一方的节点（返回 undefined 照 renderHTML） */
const DISPLAY: Record<string, (n: PMNode, cx: Cx) => string | undefined> = {
  // 行内的不再包一层 span，少一个节点
  // $$…$$ inside a line: a display formula centred on its own line (md-dmath), in the editor too
  inlineMath: (n, cx) => (n.attrs.display ? `<span class="md-dmath">${tex(cx, n.attrs.latex, true)}</span>` : tex(cx, n.attrs.latex, false)),
  blockMath: (n, cx) => `<div class="math" data-latex="${escA(n.attrs.latex)}">${tex(cx, n.attrs.latex, true)}</div>`,
  // Mermaid：先放源码，挂到页面上以后换成图。源码里常有 -->，DOMPurify 会删掉带它的属性：自己转义过，不过 DOMPurify
  codeBlock: (n, cx) => (n.attrs.language === "mermaid" ? trust(cx, `<div class="mmd" data-src="${escA(n.textContent)}"><pre class="md-code"><code>${esc(n.textContent)}</code></pre></div>`) : undefined),
  toc: (_n, cx) => `<nav data-type="toc" class="md-toc">${tocHtml(tocEntries(cx.doc))}</nav>`,
  // 不让浏览器拖图（拖的是卡片）
  // 有图注（title）的图包一层 .md-fig，图注在图下面；缩小了的宽度写在这一层上（和编辑器里的 .md-img 一样）
  image: (n) => {
    if (n.attrs.broken) return missingImageHtml(String(n.attrs.alt ?? ""), String(n.attrs.src ?? ""), escA);
    const a: Record<string, string | null> = { ...imageAttrs(n.attrs), draggable: "false" }, cap = captionOf(n.attrs.title);
    return cap ? specHtml(["span", { class: `md-fig${a.class ? " sized" : ""}`, style: a.style }, ["img", { ...a, class: null, style: null }], ["span", { class: "md-cap" }, cap]], "") : specHtml(["img", a], "");
  },
  // 一条定义都还没写（只有正文里的 [^1]）：不画空的脚注列表
  footnotes: (n) => (n.content.content.some((f) => f.childCount > 1 || f.firstChild!.content.size > 0) ? undefined : ""),
  htmlInline: (n) => userHtml(n.attrs.raw),
  htmlBlock: (n) => { const h = userHtml(n.attrs.raw); return h && `<div class="md-html">${h}</div>`; },
};
/** 链接不放 href：点了由 mdClick 交给用的一方打开，webview 自己不跳转 */
const DISPLAY_MARKS: Record<string, (m: Mark) => DOMOutputSpec> = {
  link: (m) => ["a", { class: "lnk", "data-href": m.attrs.href }, 0],
};
/** 只有一段（非空）的列表项、脚注、表格格子不画那层 <p>：外观一样（它本来就没有边距），少画一些节点 */
const SLIM = new Set(["listItem", "footnote", "tableCell", "tableHeader"]);
/** 段里有缩小了的图时留着 <p>（p.md-psized 才居中，见 markdown.css），列表项、格子里也一样 */
const sizedImg = (p: PMNode) => { let y = false; p.forEach((c) => { if (c.type.name === "image" && c.attrs.width) y = true; }); return y; };

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
    for (const m of n.marks.slice(keep)) {
      const [a, b] = markParts(m, !!cx);
      out += a;
      if (cx && m.type.name === "annot") out += `<span class="md-annot-n">${noteInline(m.attrs.note ?? "", cx.trusted)}</span>`;
      open.push({ m, close: b });
    }
    out += nodeHtml(n, cx);
  });
  while (open.length) out += open.pop()!.close;
  return out;
}
/**
 * {字|批注} 的批注：当一段行内 Markdown 画（$公式$、粗体、代码…）。读出来不是一段的（"- x" 读成了列表、"# x" 读成了标题）照原文显示；
 * 批注里再写的 {字|批注} 只留字，不再画标签
 */
function noteInline(note: string, trusted: string[]): string {
  try {
    const doc = mdSchema().nodeFromJSON(parseMd(note)), p = doc.childCount === 1 ? doc.firstChild! : null;
    if (p?.type.name !== "paragraph") return esc(note);
    const kids: PMNode[] = [];
    p.content.forEach((k) => { kids.push(k.mark(k.marks.filter((m) => m.type.name !== "annot"))); });
    return inlineHtml(Fragment.from(kids), { doc, trusted });
  } catch {
    return esc(note);
  }
}
const notes = new Map<string, string>();
/** 编辑器里批注标签的 HTML（和静态显示画的一样） */
export function annotNoteHtml(note: string): string {
  let h = notes.get(note);
  if (h !== undefined) return h;
  const trusted: string[] = [];
  h = untrust(purify(noteInline(note, trusted)), trusted);
  if (notes.size >= MAX) notes.delete(notes.keys().next().value!);
  notes.set(note, h);
  return h;
}

function nodeHtml(n: PMNode, cx: Cx | null): string {
  if (n.isText) return esc(n.text!);
  const d = cx && DISPLAY[n.type.name]?.(n, cx);
  if (d != null) return d;
  // a narrowed image is centred in its line: a class on its paragraph (markdown.css), not a p:has() rule, which Chrome
  // checks again for every paragraph on the page (the open editor's too) on each change
  if (cx && n.type.name === "paragraph" && sizedImg(n)) return specHtml(["p", { class: "md-psized" }, 0], contentHtml(n, cx));
  return specHtml(n.type.spec.toDOM!(n), contentHtml(n, cx));
}
function contentHtml(n: PMNode, cx: Cx | null): string {
  if (n.inlineContent) return inlineHtml(n.content, cx);
  const one = n.childCount === 1 ? n.firstChild! : null;
  if (cx && one && SLIM.has(n.type.name) && one.type.name === "paragraph" && one.content.size && !sizedImg(one)) return inlineHtml(one.content, cx);
  let s = "";
  n.forEach((c) => { s += nodeHtml(c, cx); });
  return s;
}
/** 不带显示时的那几处不同：和编辑器的 getHTML 对照用 */
export const schemaHtml = (doc: PMNode) => contentHtml(doc, null);

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
export const clearMdCache = () => { cache.clear(); notes.clear(); };
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
// 自己一个实例，配置只设一次：每次都传配置，DOMPurify 每次都要重新解析一遍（setConfig 是整个实例的，别影响别处用的 DOMPurify）
let purifier: ReturnType<typeof DOMPurify> | undefined;
function purify(html: string) {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.setConfig({ ADD_ATTR: ["data-note", "data-color", "data-below", "data-href", "data-latex", "data-src", "data-ref", "data-lang", "data-type", "data-checked", "data-display", "data-cbr"] });
  }
  return purifier.sanitize(html);
}

/** 只有一段时不要外面的 <p>（给单行的说明用），别的照块渲染 */
export function renderMdInline(src: string): string {
  const h = renderMd(src);
  const m = /^<p>([\s\S]*)<\/p>$/.exec(h);
  return m && !m[1].includes("<p>") ? m[1] : h;
}
