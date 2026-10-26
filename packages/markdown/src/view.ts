// 静态 Markdown 挂到页面上以后的事：[[引用]] 认目标、代码块着色、Mermaid 换成图、点链接 / 引用 / 勾选框。
import { renderMd } from "./render";
import { colorCode } from "./code";

/** [[标题]] 指向的东西（白板上是卡）：用的一方注册怎么找（这里不认识目标，单元测试能跑）。missing：找不到时的提示 */
export type RefTarget = { id: string; title: string };
type Ref = RefTarget | null;
let resolve: (label: string) => Ref = () => null;
let missing = "Nothing with this title";
export const setRefResolver = (f: (label: string) => Ref, o: { missing?: string } = {}) => { resolve = f; if (o.missing) missing = o.missing; };
export const resolveRef = (label: string) => resolve(label);

/** innerHTML 放进去以后调用：只在真的有引用 / 代码 / 图表时才去查 DOM */
export function hydrate(el: HTMLElement, html: string) {
  if (html.includes('class="cref"')) {
    for (const r of el.querySelectorAll<HTMLElement>(".cref")) {
      const hit = resolve(r.dataset.cardref ?? "");
      r.classList.toggle("missing", !hit);
      if (hit && hit.title !== r.textContent) r.textContent = hit.title;
      if (!hit) r.title = missing;
    }
  }
  if (html.includes('class="md-code" data-lang')) colorCode(el);
  if (html.includes('class="mmd"')) void import("./diagram").then((m) => m.renderAll(el));
  if (html.includes('class="md-annot"')) fitAnnots(el);
}

/**
 * {字|批注} 的标签居中在被标的字上面（markdown.css：left 50% 再往回挪半个标签宽，箭头也在正中），只用 CSS，不用量。
 * 这里只管超出：居中时写到这一块（段落、列表项、格子）左右外面去的，挪回块里（--ax，左边优先）。
 * 标签是 ::before，量不到：按它的字体用 canvas 算宽度。位置用 offsetLeft 量（同一张卡里，不受镜头缩放、滚动影响）。
 * 什么时候量：放进去时（还没挂到页面上的，下一帧）；手写字体到了（按需加载，中文字体按 unicode-range 才下载）；
 * 块变宽变窄（改卡片宽度、换行）。先全部量完再一起写，不来回排版
 */
let ctx: CanvasRenderingContext2D | null | undefined;
/** 量的时候字体还没到的：字体加载完（loadingdone）再量一次 */
const refit = new Set<HTMLElement>();
let sized: ResizeObserver | undefined;
const BLOCK = "p, li, td, th, h1, h2, h3, h4, h5, h6, summary";
function fitAnnots(el: HTMLElement) {
  if (!el.isConnected) { if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { if (el.isConnected) fitAnnots(el); }); return; }
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  if (typeof ResizeObserver === "function") sized ??= new ResizeObserver((es) => { for (const e of es) { const t = e.target as HTMLElement; if (!t.isConnected || !t.querySelector(".md-annot")) sized!.unobserve(t); else fitAnnots(t); } });
  sized?.observe(el);
  let late = false;
  const out: [HTMLElement, number][] = [];
  for (const a of el.querySelectorAll<HTMLElement>(".md-annot")) {
    const block = a.parentElement?.closest<HTMLElement>(BLOCK) ?? el;
    if (a.offsetParent !== block.offsetParent && a.offsetParent !== block) continue;
    const left = a.offsetParent === block ? a.offsetLeft : a.offsetLeft - block.offsetLeft;
    const lb = getComputedStyle(a, "::before"), note = a.dataset.note ?? "";
    ctx.font = `${lb.fontWeight} ${lb.fontSize} ${lb.fontFamily}`;
    if (!document.fonts.check(ctx.font, note)) { late = true; void document.fonts.load(ctx.font, note).catch(() => {}); }
    const w = ctx.measureText(note).width, from = left + (a.offsetWidth - w) / 2; // 居中时标签左边在块里的位置
    const room = block.clientWidth;
    let ax = from + w > room ? room - (from + w) : 0;
    if (from + ax < 0) ax = -from;
    out.push([a, Math.round(ax * 2) / 2]);
  }
  for (const [a, ax] of out) a.style.setProperty("--ax", `${ax}px`);
  if (!late) return;
  if (!refit.size) document.fonts.addEventListener("loadingdone", refitAll);
  refit.add(el);
}
function refitAll() {
  const els = [...refit];
  refit.clear();
  document.fonts.removeEventListener("loadingdone", refitAll);
  for (const el of els) if (el.isConnected) fitAnnots(el);
}

/**
 * 静态 Markdown 上的点击：链接交给 openLink（webview 自己不跳转），引用交给 openRef（白板上是跳到卡），勾选框改原文。处理了返回 true。
 * onToggle 给了才能勾（拿到改好的原文）
 */
export function mdClick(e: MouseEvent, src: string, o: { openLink: (u: string) => void; openRef: (id: string) => void; onToggle?: (next: string) => void }): boolean {
  const t = e.target as HTMLElement;
  const a = t.closest?.("a.lnk") as HTMLElement | null;
  if (a?.dataset.href) { e.preventDefault(); e.stopPropagation(); o.openLink(a.dataset.href); return true; }
  const r = t.closest?.(".cref") as HTMLElement | null;
  if (r) {
    e.preventDefault(); e.stopPropagation();
    const hit = resolve(r.dataset.cardref ?? "");
    if (hit) o.openRef(hit.id);
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
