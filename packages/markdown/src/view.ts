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
 * {字|批注} 的标签从被标的字的左边开始写；写到这一块（段落、列表项、格子）右边外面去的，往左挪回来（--ax），最多挪到块的左边。
 * 标签是 ::before，量不到：按它的字体用 canvas 算宽度。位置用 offsetLeft 量（同一张卡里，不受镜头缩放、滚动影响）
 */
let ctx: CanvasRenderingContext2D | null | undefined;
function fitAnnots(el: HTMLElement) {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  for (const a of el.querySelectorAll<HTMLElement>(".md-annot")) {
    const block = a.parentElement?.closest<HTMLElement>("p, li, td, th, h1, h2, h3, h4, h5, h6, summary") ?? el;
    if (a.offsetParent !== block.offsetParent && a.offsetParent !== block) continue;
    const left = a.offsetParent === block ? a.offsetLeft : a.offsetLeft - block.offsetLeft;
    const lb = getComputedStyle(a, "::before");
    ctx.font = `${lb.fontWeight} ${lb.fontSize} ${lb.fontFamily}`;
    const over = left + ctx.measureText(a.dataset.note ?? "").width - block.clientWidth;
    a.style.setProperty("--ax", over > 0 ? `${-Math.min(over, Math.max(0, left))}px` : "0px");
  }
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
