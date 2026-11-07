// 卡片被删掉时的消失动画：先复制一份当前的 DOM 留在原地（不可交互），缩小淡出后移除（多长看主题：look.ts 的 ghost）。
// 数据立刻删，撤销、存盘都不用等动画。
import { GHOST_OUT } from "./timing";
import { cardSel } from "../cardsel";
import { animScale, reduceMotion } from "./motion";
import { shape } from "./look";

export function ghostOut(ids: Iterable<string>) {
  if (reduceMotion()) return;
  const ms = (shape().ghost ?? GHOST_OUT) * animScale() + 40; // 加两帧：动画在两次 requestAnimationFrame 之后才开始
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`${cardSel(id)}`);
    if (!el?.parentElement) continue;
    const g = el.cloneNode(true) as HTMLElement;
    keepPictures(el, g);
    g.removeAttribute("data-id");
    g.classList.add("ghost-out");
    g.classList.remove("sel");
    el.parentElement.appendChild(g);
    requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add("go")));
    setTimeout(() => g.remove(), ms);
  }
}

/**
 * A cloned <img> loads its picture again (decoding="async", loading="lazy" copied too): the first frames painted the ghost
 * without it, the picture blinking out and back as the card started to go (an Image card, a Note's images). The card's own
 * images, loaded and decoded, go into the ghost instead (the card is removed this same task; its copies take their places);
 * a canvas's drawing is copied over
 */
function keepPictures(el: HTMLElement, g: HTMLElement) {
  const from = el.querySelectorAll("img, canvas"),
    to = g.querySelectorAll("img, canvas");
  if (from.length !== to.length) return;
  from.forEach((a, i) => {
    const b = to[i];
    if (a instanceof HTMLImageElement && b instanceof HTMLImageElement) {
      if (!a.complete || !a.naturalWidth) return;
      const mark = document.createComment("");
      a.replaceWith(mark);
      b.replaceWith(a);
      mark.replaceWith(b);
    } else if (a instanceof HTMLCanvasElement && b instanceof HTMLCanvasElement && a.width && a.height)
      b.getContext("2d")?.drawImage(a, 0, 0);
  });
}
