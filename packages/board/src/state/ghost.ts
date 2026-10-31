// 卡片被删掉时的消失动画：先复制一份当前的 DOM 留在原地（不可交互），缩小淡出后移除。
// 数据立刻删，撤销、存盘都不用等动画。
import { GHOST_OUT } from "./timing";

/** 动画的快慢（styles.css 的 --t：慢动作设置、系统「减少动态效果」）：CSS 里的时长都乘它，JS 里等动画的计时器也要乘 */
export const animScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--t")) || 1;

export function ghostOut(ids: Iterable<string>) {
  // 不引 camera.ts：store 引这个文件，camera 又引 store，会循环依赖
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ms = GHOST_OUT * animScale() + 40; // 加两帧：动画在两次 requestAnimationFrame 之后才开始
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"]`);
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
