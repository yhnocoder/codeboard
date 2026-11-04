/** [[标题]] 指向的东西（白板上是卡）。badge = 标在标题后面的小字（白板：在别的白板上的卡写那块白板的名字），place = 它在哪（点的时候交给 openRef） */
export type RefTarget = { id: string; title: string; badge?: string; place?: string };
/** 认得出指的是哪儿、但已经找不到了：item = 那里已经没有这一项（灰、划掉），place = 那个地方本身没了（警告色）。why = 悬停的提示 */
export type RefBroken = { broken: "item" | "place"; title: string; badge?: string; why?: string };
/** [[标题]] 怎么找目标：target = 从 [[ 列表选的时候带上的目标 id（[[标题#^id]]，见 schema-nodes.ts WikiRef），先按它找；missing：找不到时的提示 */
export type Refs = { resolve: (label: string, target?: string) => RefTarget | RefBroken | null; missing?: string };
const MISSING = "Nothing with this title";

/** 按现在能找到的把一个 [[引用]]（.md-ref）画出来：标题（和 badge），找不到时的样子和提示 */
export function paintRef(r: HTMLElement, refs: Refs) {
  const hit = refs.resolve(r.dataset.ref ?? "", r.dataset.target || undefined),
    missing = refs.missing || MISSING;
  const broken = hit && "broken" in hit ? hit.broken : undefined;
  r.classList.toggle("missing", !hit || broken === "item");
  r.classList.toggle("gone", broken === "place");
  if (!hit) {
    r.title = missing;
    return;
  }
  if (broken) r.title = (hit as RefBroken).why ?? missing;
  else r.removeAttribute("title");
  const t = r.querySelector<HTMLElement>(":scope > .t"),
    bd = r.querySelector<HTMLElement>(":scope > .bd");
  if (!hit.badge) {
    if (t || r.textContent !== hit.title) r.textContent = hit.title;
    return;
  }
  if (t?.textContent === hit.title && bd?.textContent === hit.badge && r.childNodes.length === 2) return;
  const a = document.createElement("span"),
    b = document.createElement("span");
  a.className = "t";
  a.textContent = hit.title;
  b.className = "bd";
  b.textContent = hit.badge;
  r.replaceChildren(a, b);
}

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
export function copyTex(e: ClipboardEvent) {
  const sel = getSelection(),
    el = e.currentTarget as HTMLElement;
  if (!sel?.rangeCount || !e.clipboardData) return;
  const r = sel.getRangeAt(0).cloneRange();
  const at = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>(".katex-display, .katex");
  const a = at(r.startContainer),
    b = at(r.endContainer);
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
  for (const b of box.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, .math, tr"))
    b.after(/^(LI|TR)$/.test(b.tagName) ? "\n" : "\n\n");
  return (box.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
/**
 * 静态 Markdown 上的点击：链接交给 openLink（页面自己不跳转），引用交给 openRef，勾选框改原文交给 onToggle（不给就勾不了）。
 * 处理了返回 true
 */
export type ClickOpts = {
  openLink: (u: string) => void;
  openRef: (id: string, to: RefTarget) => void;
  onToggle?: (next: string) => void;
};
export function mdClick(e: MouseEvent, src: string, o: ClickOpts, refs: Refs): boolean {
  const t = e.target as HTMLElement;
  const a = t.closest?.("a.md-link") as HTMLElement | null;
  if (a?.dataset.href) {
    e.preventDefault();
    e.stopPropagation();
    o.openLink(a.dataset.href);
    return true;
  }
  const r = t.closest?.(".md-ref") as HTMLElement | null;
  if (r) {
    e.preventDefault();
    e.stopPropagation();
    const hit = refs.resolve(r.dataset.ref ?? "", r.dataset.target || undefined);
    if (hit && !("broken" in hit)) o.openRef(hit.id, hit);
    return true;
  }
  if (t instanceof HTMLInputElement && t.type === "checkbox" && t.closest("li[data-type=taskItem]")) {
    e.preventDefault();
    e.stopPropagation();
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
  let fence = "",
    n = -1;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(l);
    if (m && ++n === i) {
      lines[k] = m[1] + (m[2] === " " ? "x" : " ") + m[3];
      return lines.join("\n");
    }
  }
  return null;
}
