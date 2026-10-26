// 只在编辑器自己会滚的框里滚（比如定了高度的 Note），不动外面：白板靠镜头移动，不靠滚动

/** 离 el 最近的、内容超出了的竖滚祖先；页面本身不算 */
export function scroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** 把屏幕上 top…bottom 这一段尽量少地滚进 box 看得见的地方（留出 box 的上下内边距）；放不下时 top 优先。
 *  box 可能被缩放（白板的镜头）：按显示的比例换算 */
export function revealIn(box: HTMLElement, top: number, bottom: number) {
  const r = box.getBoundingClientRect(), cs = getComputedStyle(box);
  const k = box.offsetHeight ? r.height / box.offsetHeight : 1;
  const vt = r.top + box.clientTop * k, vb = vt + box.clientHeight * k;
  const pt = Math.max(4, parseFloat(cs.paddingTop) || 0) * k, pb = Math.max(4, parseFloat(cs.paddingBottom) || 0) * k;
  let d = 0;
  if (bottom > vb - pb) d = bottom - (vb - pb);
  if (top - d < vt + pt) d = top - (vt + pt);
  if (Math.abs(d) >= 0.5) box.scrollTop += d / k;
}
