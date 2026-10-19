// 卡片被删掉时的消失动画：先复制一份当前的 DOM 留在原地（不可交互），缩小淡出后移除。
// 数据立刻删，撤销、存盘都不用等动画。

export function ghostOut(ids: Iterable<string>) {
  // 不引 camera.ts：store 引这个文件，camera 又引 store，会循环依赖
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
    if (!el?.parentElement) continue;
    const g = el.cloneNode(true) as HTMLElement;
    g.removeAttribute("data-id");
    g.classList.add("ghost-out");
    g.classList.remove("sel");
    el.parentElement.appendChild(g);
    requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add("go")));
    setTimeout(() => g.remove(), 260);
  }
}
