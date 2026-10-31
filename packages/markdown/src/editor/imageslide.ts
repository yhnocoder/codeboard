// An image's source line opening above it (the caret entered the image) or closing again pushes the image, and everything after
// its paragraph, by a line. Instead of jumping they slide (FLIP: measured before ProseMirror redraws, then animated from the old
// place to the new one with transforms only), and the opened source fades in. Reduced motion: no animation
import type { EditorView } from "@tiptap/pm/view";
import { IMAGE_SLIDE } from "../ui/timing";

type Before = { pos: number; img: number; bottom: number };
const EASE = "cubic-bezier(.2, .7, .3, 1)";
/** Siblings after the paragraph that slide with it (the rest are off screen) */
const MAX_FOLLOW = 40;

const imgOf = (dom: Element) => dom.querySelector<HTMLElement>(".md-img");
/** Measures the paragraphs (by position) whose images may move with this change of caret, while the old layout is on screen */
export function measureImages(view: EditorView, blocks: number[]): Before[] {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return [];
  const out: Before[] = [];
  for (const pos of blocks) {
    const dom = view.nodeDOM(pos);
    const img = dom instanceof HTMLElement ? imgOf(dom) : null;
    if (!img) continue;
    out.push({ pos, img: img.getBoundingClientRect().top, bottom: (dom as HTMLElement).getBoundingClientRect().bottom });
  }
  return out;
}

/** After the redraw: slides each image, and what follows its paragraph, from where it was; fades in a source that opened */
export function slideImages(view: EditorView, before: Before[]) {
  for (const b of before) {
    const dom = view.nodeDOM(b.pos);
    if (!(dom instanceof HTMLElement)) continue;
    const img = imgOf(dom);
    if (!img) continue;
    const dy = b.img - img.getBoundingClientRect().top, dBottom = b.bottom - dom.getBoundingClientRect().bottom;
    if (Math.abs(dy) < 0.5 && Math.abs(dBottom) < 0.5) continue;
    const slide = (el: Element, d: number) => { if (Math.abs(d) >= 0.5) el.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: IMAGE_SLIDE, easing: EASE }); };
    slide(img, dy);
    // what follows the paragraph, at each level up to the editor (a paragraph in a list item, a cell…)
    let n = 0;
    for (let el: Element | null = dom; el && el !== view.dom && n < MAX_FOLLOW; el = el.parentElement) {
      for (let s = el.nextElementSibling; s && n < MAX_FOLLOW; s = s.nextElementSibling, n++) slide(s, dBottom);
    }
    // the source line that opened: its markers and address fade in
    if (img.classList.contains("below")) {
      for (const m of dom.querySelectorAll(".md-mk:not(.md-hide), .md-imgalt, .md-fold, .md-ell")) m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IMAGE_SLIDE, easing: "ease-out" });
    }
  }
}
