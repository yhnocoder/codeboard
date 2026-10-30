import { renderMd } from "./render";
import { colorCode } from "./code";

/** [[标题]] 指向的东西（白板上是卡）。badge = 标在标题后面的小字（白板：在别的白板上的卡写那块白板的名字），place = 它在哪（点的时候交给 openRef） */
export type RefTarget = { id: string; title: string; badge?: string; place?: string };
/** 认得出指的是哪儿、但已经找不到了：item = 那里已经没有这一项（灰、划掉），place = 那个地方本身没了（警告色）。why = 悬停的提示 */
export type RefBroken = { broken: "item" | "place"; title: string; badge?: string; why?: string };
type Ref = RefTarget | RefBroken | null;
let resolve: (label: string) => Ref = () => null;
let missing = "Nothing with this title";
/** 接上 [[标题]] 怎么找目标；missing：找不到时的提示 */
export const setRefResolver = (f: (label: string) => Ref, o: { missing?: string } = {}) => { resolve = f; if (o.missing) missing = o.missing; };
export const resolveRef = (label: string) => resolve(label);

/** 按现在能找到的把一个 [[引用]]（.md-ref）画出来：标题（和 badge），找不到时的样子和提示。数据晚到（别的白板的卡）时用的一方再调一次 */
export function paintRef(r: HTMLElement) {
  const hit = resolve(r.dataset.ref ?? "");
  const broken = hit && "broken" in hit ? hit.broken : undefined;
  r.classList.toggle("missing", !hit || broken === "item");
  r.classList.toggle("gone", broken === "place");
  if (!hit) { r.title = missing; return; }
  if (broken) r.title = (hit as RefBroken).why ?? missing; else r.removeAttribute("title");
  const t = r.querySelector<HTMLElement>(":scope > .t"), bd = r.querySelector<HTMLElement>(":scope > .bd");
  if (!hit.badge) { if (t || r.textContent !== hit.title) r.textContent = hit.title; return; }
  if (t?.textContent === hit.title && bd?.textContent === hit.badge && r.childNodes.length === 2) return;
  const a = document.createElement("span"), b = document.createElement("span");
  a.className = "t"; a.textContent = hit.title;
  b.className = "bd"; b.textContent = hit.badge;
  r.replaceChildren(a, b);
}

const IMG_ERR = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.8"/><path d="M2.5 11l3.2-3.2 2.6 2.6 1.7-1.7 3.5 3.5M10.2 6.2h.01"/></svg>';
/** Addresses that failed to load: drawn as the placeholder at once next time (no broken image in between) */
const failedImages = new Set<string>();
/** An image that could not load: a quiet line in its place (the alt text, or the address), not the browser's broken icon */
export function imageFailed(img: HTMLImageElement) {
  const src = img.getAttribute("src") ?? "";
  if (src) failedImages.add(src);
  const box = document.createElement("span"), t = document.createElement("span");
  box.className = "md-imgerr";
  box.title = src;
  box.innerHTML = IMG_ERR;
  t.textContent = `Image failed to load · ${img.alt || src}`;
  box.append(t);
  img.replaceWith(box);
}
export const imageFailedBefore = (src: string | null) => !!src && failedImages.has(src);
const onImageError = (e: Event) => { if (e.target instanceof HTMLImageElement && e.target.closest(".md")) imageFailed(e.target); };
const watched = new WeakSet<HTMLElement>();

/** renderMd 的 HTML 用 innerHTML 放进 el 以后调用：认 [[引用]]、代码块着色、Mermaid 换成图、摆批注标签 */
/**
 * A copy's formulas as their TeX: each typeset formula in root (a copied fragment, never the page) becomes its $TeX$ ($$TeX$$ for a
 * display one) inside the same .katex element, which keeps data-latex. Another app gets the TeX as text; our paste reads data-latex.
 * The page itself draws HTML only, without MathML (whose <annotation> would carry the TeX, at a cost on every edit; see widgets.ts)
 */
export function texForCopy(root: ParentNode) {
  for (const k of root.querySelectorAll<HTMLElement>(".katex[data-latex]")) {
    const d = !!k.closest(".katex-display");
    k.textContent = d ? `$$${k.dataset.latex}$$` : `$${k.dataset.latex}$`;
  }
}
/** A copy from the static render: a selection that cuts into a formula takes all of it, and every formula goes as its TeX */
function copyTex(e: ClipboardEvent) {
  const sel = getSelection(), el = e.currentTarget as HTMLElement;
  if (!sel?.rangeCount || !e.clipboardData) return;
  const r = sel.getRangeAt(0).cloneRange();
  const at = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>(".katex-display, .katex");
  const a = at(r.startContainer), b = at(r.endContainer);
  if (a && el.contains(a)) r.setStartBefore(a);
  if (b && el.contains(b)) r.setEndAfter(b);
  const frag = r.cloneContents();
  if (!frag.querySelector(".katex[data-latex]")) return;
  texForCopy(frag);
  const box = document.createElement("div");
  box.append(frag);
  e.clipboardData.setData("text/html", box.innerHTML);
  e.clipboardData.setData("text/plain", plainOf(box));
  e.preventDefault();
}
/** The copied fragment's text with its blocks on lines of their own (textContent alone runs paragraphs together) */
function plainOf(box: HTMLElement) {
  for (const b of box.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, .math, tr")) b.after(/^(LI|TR)$/.test(b.tagName) ? "\n" : "\n\n");
  return (box.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
const copying = new WeakSet<HTMLElement>();

export function hydrate(el: HTMLElement, html: string) {
  if (html.includes("data-latex") && !copying.has(el)) { copying.add(el); el.addEventListener("copy", copyTex); }
  if (html.includes("<img")) {
    // error does not bubble: caught on the way down
    if (!watched.has(el)) { watched.add(el); el.addEventListener("error", onImageError, true); }
    for (const img of el.querySelectorAll("img")) if (imageFailedBefore(img.getAttribute("src")) || (img.complete && !img.naturalWidth && img.getAttribute("src"))) imageFailed(img);
  }
  if (html.includes('class="md-ref"')) for (const r of el.querySelectorAll<HTMLElement>(".md-ref")) paintRef(r);
  if (html.includes('class="md-code" data-lang')) colorCode(el);
  if (html.includes('class="mmd"')) void import("./diagram").then((m) => m.renderAll(el));
  if (html.includes('class="md-annot"')) fitAnnots(el);
}

/*
 * {字|批注} 的标签（.md-annot-n）靠 CSS 居中在被标的字上面；这里只把居中后超出所在块（段落、列表项、格子）左右的挪回块里（--ax，左边优先）。
 * 宽度、位置都用 offset* 量（不受镜头缩放、滚动和 --ax 的 transform 影响）。先全部量完再一起写，不来回排版。
 * 字体（中文字体按 unicode-range 才下载）、公式的字体到得晚，标签变宽时 ResizeObserver 再量一次；块变宽变窄（卡片改宽）也一样
 */
let sized: ResizeObserver | undefined;
const rootOf = new WeakMap<Element, HTMLElement>();
const BLOCK = "p, li, td, th, h1, h2, h3, h4, h5, h6, summary";
function fitAnnots(el: HTMLElement) {
  if (!el.isConnected) { if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (el.isConnected) fitAnnots(el); }); return; }
  if (typeof ResizeObserver === "function") sized ??= new ResizeObserver((es) => {
    const todo = new Set<HTMLElement>();
    for (const e of es) {
      const t = e.target as HTMLElement, root = rootOf.get(t) ?? t;
      if (!t.isConnected || !root.isConnected || !root.querySelector(".md-annot")) sized!.unobserve(t); else todo.add(root);
    }
    for (const r of todo) fitAnnots(r);
  });
  sized?.observe(el);
  const out: [HTMLElement, number][] = [];
  for (const a of el.querySelectorAll<HTMLElement>(".md-annot")) {
    const n = a.querySelector<HTMLElement>(":scope > .md-annot-n");
    if (!n) continue;
    if (rootOf.get(n) !== el) { rootOf.set(n, el); sized?.observe(n); }
    const block = a.parentElement?.closest<HTMLElement>(BLOCK) ?? el;
    if (a.offsetParent !== block.offsetParent && a.offsetParent !== block) continue;
    const left = a.offsetParent === block ? a.offsetLeft : a.offsetLeft - block.offsetLeft;
    const w = n.offsetWidth, from = left + (a.offsetWidth - w) / 2; // 居中时标签左边在块里的位置
    const room = block.clientWidth;
    let ax = from + w > room ? room - (from + w) : 0;
    if (from + ax < 0) ax = -from;
    out.push([a, Math.round(ax * 2) / 2]);
  }
  for (const [a, ax] of out) a.style.setProperty("--ax", `${ax}px`);
}

/**
 * 静态 Markdown 上的点击：链接交给 openLink（页面自己不跳转），引用交给 openRef，勾选框改原文交给 onToggle（不给就勾不了）。
 * 处理了返回 true
 */
export function mdClick(e: MouseEvent, src: string, o: { openLink: (u: string) => void; openRef: (id: string, to: RefTarget) => void; onToggle?: (next: string) => void }): boolean {
  const t = e.target as HTMLElement;
  const a = t.closest?.("a.lnk") as HTMLElement | null;
  if (a?.dataset.href) { e.preventDefault(); e.stopPropagation(); o.openLink(a.dataset.href); return true; }
  const r = t.closest?.(".md-ref") as HTMLElement | null;
  if (r) {
    e.preventDefault(); e.stopPropagation();
    const hit = resolve(r.dataset.ref ?? "");
    if (hit && !("broken" in hit)) o.openRef(hit.id, hit);
    return true;
  }
  if (t instanceof HTMLInputElement && t.type === "checkbox" && t.closest("li[data-type=taskItem]")) {
    e.preventDefault(); e.stopPropagation();
    if (!o.onToggle) return true;
    const root = t.closest(".md") ?? t.parentElement!;
    const i = [...root.querySelectorAll("li[data-type=taskItem] > label > input")].indexOf(t);
    const next = toggleTask(src, i);
    if (next !== null) o.onToggle(next);
    return true;
  }
  return false;
}

/** 把第 i 个任务（- [ ] / - [x]）勾上或取消；代码块里的不算。找不到返回 null */
export function toggleTask(src: string, i: number): string | null {
  const lines = src.split("\n");
  let fence = "", n = -1;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = ""; continue; }
    if (fence) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(l);
    if (m && ++n === i) { lines[k] = m[1] + (m[2] === " " ? "x" : " ") + m[3]; return lines.join("\n"); }
  }
  return null;
}

export { renderMd };
