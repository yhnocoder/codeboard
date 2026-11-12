// 卡片被删掉时的消失动画：先复制一份当前的 DOM 留在原地（不可交互），缩小淡出后移除（多长看主题：look.ts 的 ghost）。
// 数据立刻删，撤销、存盘都不用等动画。
import { GHOST_OUT } from "./timing";
import { cardSel } from "../cardsel";
import { animScale, reduceMotion } from "./motion";
import { shape } from "./look";

/** Leaves a fading copy of each card in place; call the returned function when the delete did not happen after all: the
 *  copies go and the card gets its pictures back */
export function ghostOut(ids: Iterable<string>): () => void {
  const undo: (() => void)[] = [];
  const cancel = () => {
    for (const u of undo.splice(0)) u();
  };
  if (reduceMotion()) return cancel;
  const ms = (shape().ghost ?? GHOST_OUT) * animScale() + 40; // 加两帧：动画在两次 requestAnimationFrame 之后才开始
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`${cardSel(id)}`);
    if (!el?.parentElement) continue;
    const g = el.cloneNode(true) as HTMLElement;
    const back = keepPictures(el, g);
    g.removeAttribute("data-id");
    g.classList.add("ghost-out");
    g.classList.remove("sel");
    el.parentElement.appendChild(g);
    requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add("go")));
    const t = setTimeout(() => g.remove(), ms);
    undo.push(() => {
      clearTimeout(t);
      back();
      g.remove();
    });
  }
  return cancel;
}

/**
 * A cloned <img> loads its picture again (lazy and decoded async, as board images were then): the first frames painted the ghost
 * without it, the picture blinking out and back as the card started to go (an Image card, a Note's images). The card's own
 * images, loaded and decoded, go into the ghost instead (the card is removed this same task; its copies take their places);
 * a canvas's drawing is copied over
 */
function keepPictures(el: HTMLElement, g: HTMLElement): () => void {
  const swaps: [HTMLImageElement, HTMLImageElement][] = [];
  const swap = (a: Element, b: Element) => {
    const mark = document.createComment("");
    a.replaceWith(mark);
    b.replaceWith(a);
    mark.replaceWith(b);
  };
  const back = () => {
    for (const [a, b] of swaps.splice(0)) swap(a, b);
  };
  const from = el.querySelectorAll("img, canvas"),
    to = g.querySelectorAll("img, canvas");
  if (from.length !== to.length) return back;
  from.forEach((a, i) => {
    const b = to[i];
    if (a instanceof HTMLImageElement && b instanceof HTMLImageElement) {
      if (!a.complete || !a.naturalWidth) return;
      swap(a, b);
      swaps.push([a, b]);
    } else if (a instanceof HTMLCanvasElement && b instanceof HTMLCanvasElement && a.width && a.height)
      b.getContext("2d")?.drawImage(a, 0, 0);
  });
  return back;
}
