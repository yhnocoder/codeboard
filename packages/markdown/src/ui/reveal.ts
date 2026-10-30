// 只在编辑器自己会滚的框里滚（比如定了高度的 Note），不动外面：白板靠镜头移动，不靠滚动

/** 像 el.scrollIntoView，但只滚 el 最近的那个滚动框（列表、设置页）。scrollIntoView 会一路滚到嵌着这一页的页面里
 *  （container: "nearest" 也挡不住，Chromium 150）：VS Code 里 webview 外面那个框还能滚几 px，整块白板跟着挪，
 *  挪的时候落下的点击就到了 VS Code 而不是白板。start 对齐时算上 el 的 scroll-margin-top */
export function scrollIntoBox(el: Element, block: "start" | "center" | "nearest") {
  const box = scroller(el);
  if (!box) return;
  const r = el.getBoundingClientRect();
  if (block === "nearest") return revealIn(box, r.top, r.bottom);
  const b = box.getBoundingClientRect(), k = box.offsetHeight ? b.height / box.offsetHeight : 1;
  const top = b.top + box.clientTop * k;
  const at = block === "start" ? top + (parseFloat(getComputedStyle(el).scrollMarginTop) || 0) * k : top + (box.clientHeight * k - r.height) / 2;
  if (Math.abs(r.top - at) >= 0.5) box.scrollTop += (r.top - at) / k;
}

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
