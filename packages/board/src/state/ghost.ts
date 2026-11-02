// 卡片被删掉时的消失动画：先复制一份当前的 DOM 留在原地（不可交互），缩小淡出后移除。
// 数据立刻删，撤销、存盘都不用等动画。
import { GHOST_OUT } from "./timing";
import { cardSel } from "../cardsel";
import { animScale, reduceMotion } from "./motion";

export function ghostOut(ids: Iterable<string>) {
  if (reduceMotion()) return;
  const ms = GHOST_OUT * animScale() + 40; // 加两帧：动画在两次 requestAnimationFrame 之后才开始
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`${cardSel(id)}`);
    if (!el?.parentElement) continue;
    const g = el.cloneNode(true) as HTMLElement;
    g.removeAttribute("data-id");
    g.classList.add("ghost-out");
    g.classList.remove("sel");
    el.parentElement.appendChild(g);
    requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add("go")));
    setTimeout(() => g.remove(), ms);
  }
}
