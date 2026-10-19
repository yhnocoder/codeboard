// 静态 Markdown 挂到页面上以后的事：[[卡片引用]] 认卡、Mermaid 换成图、点链接 / 引用 / 勾选框。
import { renderMd } from "./render";

/** [[标题]] 找卡：白板那边注册（这里不直接依赖白板状态，单元测试能跑） */
type Ref = { id: string; title: string } | null;
let resolve: (label: string) => Ref = () => null;
export const setRefResolver = (f: (label: string) => Ref) => { resolve = f; };
export const resolveRef = (label: string) => resolve(label);

/** innerHTML 放进去以后调用：只在真的有引用 / 图表时才去查 DOM */
export function hydrate(el: HTMLElement, html: string) {
  if (html.includes('class="cref"')) {
    for (const r of el.querySelectorAll<HTMLElement>(".cref")) {
      const hit = resolve(r.dataset.cardref ?? "");
      r.classList.toggle("missing", !hit);
      if (hit && hit.title !== r.textContent) r.textContent = hit.title;
      if (!hit) r.title = "No card with this title on the board";
    }
  }
  if (html.includes('class="mmd"')) void import("./mermaid").then((m) => m.renderAll(el));
}

/**
 * 静态 Markdown 上的点击：链接交给宿主打开，引用跳到卡，勾选框改原文。处理了返回 true。
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
