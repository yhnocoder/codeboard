/**
 * A short coloured mark ("seal") drawn before a ref's title instead of a badge: the place the target is in, as `text` on a fill of
 * `color` (any CSS colour). `outer`: the larger place that one is part of, drawn as the first half of the same box (its text in
 * its colour, on a light tint of it). `alone`: the ref names the place itself, so only the seal is drawn, without the title
 */
export type RefSeal = { text: string; color: string; outer?: { text: string; color: string }; alone?: boolean };
/**
 * [[标题]] 指向的东西（白板上是卡）。badge = 标在标题后面的小字，seal = 画在标题前面的印章（有 seal 时不画 badge），
 * hint = 悬停时的提示（比如完整的路径），place = 它在哪（点的时候交给 openRef）
 */
export type RefTarget = { id: string; title: string; badge?: string; seal?: RefSeal; hint?: string; place?: string };
/** 认得出指的是哪儿、但已经找不到了：item = 那里已经没有这一项（灰、划掉），place = 那个地方本身没了（警告色）。why = 悬停的提示 */
export type RefBroken = { broken: "item" | "place"; title: string; badge?: string; why?: string };
/**
 * [[标题]] 怎么找目标：target = 从 [[ 列表选的时候带上的目标 id（[[标题#^id]]，见 schema-nodes.ts WikiRef），先按它找；missing：找不到时的提示。
 * link：一个链接的地址指的是一项（页面自己的 Copy Link 复制的）时，它代表的 target（同 [[标题#^target]]），别的地址给 null。这样的链接
 * 保留自己的字，画成找到 / 找不到的样子，点它和点引用一样（openRef）
 */
export type Refs = {
  resolve: (label: string, target?: string) => RefTarget | RefBroken | null;
  missing?: string;
  link?: (href: string) => string | null;
};
const MISSING = "Nothing with this title";

/** 上次画成什么样（一样就不重画，静态 Note 里的引用每次别处的数据到了都会再认一遍） */
const painted = new WeakMap<HTMLElement, string>();

/** 按现在能找到的把一个 [[引用]]（.md-ref）画出来：印章、标题（和 badge），找不到时的样子和提示 */
export function paintRef(r: HTMLElement, refs: Refs) {
  const hit = refs.resolve(r.dataset.ref ?? "", r.dataset.target || undefined),
    missing = refs.missing || MISSING;
  const broken = hit && "broken" in hit ? hit.broken : undefined;
  r.classList.toggle("missing", !hit || broken === "item");
  r.classList.toggle("gone", broken === "place");
  const seal = hit && !broken ? (hit as RefTarget).seal : undefined;
  r.classList.toggle("sealed", !!seal);
  if (!hit) {
    painted.delete(r);
    r.title = missing;
    return;
  }
  const hint = broken ? ((hit as RefBroken).why ?? missing) : (hit as RefTarget).hint;
  if (hint) r.title = hint;
  else r.removeAttribute("title");
  const key = JSON.stringify([hit.title, seal ?? hit.badge ?? null]);
  if (painted.get(r) === key && r.childNodes.length) return;
  painted.set(r, key);
  if (seal) {
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = hit.title;
    r.replaceChildren(sealEl(seal), ...(seal.alone ? [] : [t]));
    return;
  }
  if (!hit.badge) {
    r.textContent = hit.title;
    return;
  }
  const a = document.createElement("span"),
    b = document.createElement("span");
  a.className = "t";
  a.textContent = hit.title;
  b.className = "bd";
  b.textContent = hit.badge;
  r.replaceChildren(a, b);
}

/** A link whose address names an item (Refs.link): the target, its classes (md-cardlink, and missing / gone as a reference's)
 *  and its hint; null for any other link */
export function cardLinkLook(href: string, refs: Refs): { target: string; class: string; title?: string } | null {
  const target = href ? refs.link?.(href) : null;
  if (!target) return null;
  const hit = refs.resolve("", target),
    broken = hit && "broken" in hit ? hit.broken : undefined;
  const cls = `md-cardlink${!hit || broken === "item" ? " missing" : broken === "place" ? " gone" : ""}`;
  const title = !hit
    ? refs.missing || MISSING
    : broken
      ? ((hit as RefBroken).why ?? refs.missing ?? MISSING)
      : (hit as RefTarget).hint;
  return { target, class: cls, title };
}
/** A rendered link (a.md-link) drawn as what its address names, when that is an item: true when it is one */
export function paintLink(a: HTMLElement, refs: Refs): boolean {
  const look = cardLinkLook(a.dataset.href ?? "", refs);
  a.classList.remove("md-cardlink", "missing", "gone");
  if (!look) return false;
  a.classList.add(...look.class.split(" "));
  a.dataset.target = look.target;
  if (look.title) a.title = look.title;
  else a.removeAttribute("title");
  return true;
}

/** 印章：一个圆角框；有 outer 时分成两半，前一半是外面那一处的（描边、浅底），后一半是这一处的（实心）。
 * 字包在 .md-seal-t 里（不叫 .tx：白板的 Text 卡也是 .tx，它的字色、最小高度会套到印章的字上）：它按大写字母的高到基线裁掉行框（text-box），框里居中的就是字本身，不受字体上下留白不同的影响 */
function sealEl(s: RefSeal): HTMLElement {
  const el = document.createElement("span");
  el.className = `md-seal${s.outer ? " two" : ""}${s.alone ? " alone" : ""}`;
  el.style.setProperty("--md-seal", s.color);
  const tx = (text: string) => {
    const t = document.createElement("span");
    t.className = "md-seal-t";
    t.textContent = text;
    return t;
  };
  if (!s.outer) {
    el.append(tx(s.text));
    return el;
  }
  el.style.setProperty("--md-seal-outer", s.outer.color);
  const a = document.createElement("span"),
    b = document.createElement("span");
  a.className = "o";
  a.append(tx(s.outer.text));
  b.append(tx(s.text));
  el.append(a, b);
  return el;
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
/** A copy from the static render: a selection that cuts into a formula takes all of it, every formula goes as its TeX and a
 *  folded address (url.ts) as written */
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
  if (!frag.querySelector(".katex[data-latex], .md-short")) return;
  texForCopy(frag);
  for (const s of frag.querySelectorAll<HTMLElement>(".md-short")) s.textContent = s.dataset.src ?? s.textContent;
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
    // a link to an item: as a reference to it (nothing when that is gone)
    const target = refs.link?.(a.dataset.href);
    if (!target) o.openLink(a.dataset.href);
    else {
      const hit = refs.resolve("", target);
      if (hit && !("broken" in hit)) o.openRef(hit.id, hit);
    }
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
