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

/** renderMd 的 HTML 用 innerHTML 放进 el 以后调用：认 [[引用]]、代码块着色、Mermaid 换成图、摆批注标签 */
export function hydrate(el: HTMLElement, html: string) {
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
