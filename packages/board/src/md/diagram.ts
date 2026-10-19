// Mermaid 图：页面上有 ```mermaid 块时才加载 pele（Mermaid 语法 → SVG，同步、没有依赖）。
// 颜色是 SVG 里的 CSS 变量（styles.css 的 .mmd 把 --pele-* 接到主题变量上），换明暗、换主题配色都不用重画。
// 布局跟字体和宽度有关：按「字体 + 宽度上限 + 源码」缓存。图比 Note 宽就给 pele 宽度上限（maxWidth），它改成竖着排，
// 字不缩小；拖宽 Note 放得下了再换回原来的方向。换了字体的主题、Note 宽度跨了档才重画
import { observeResize, queueMeasure } from "../state/measure";

type P = typeof import("pele");
let lib: P | undefined;
const drawn = new Map<string, { svg: string; width: number }>();
let n = 0;
const STEP = 40; // 宽度上限按 40px 分档：拖 Note 边时不用每个像素都重新排

const fontOf = () => getComputedStyle(document.documentElement).getPropertyValue("--sys").trim();

function draw(p: P, src: string, font: string, max: number) {
  const key = `${font}\n${max}\n${src}`;
  let d = drawn.get(key);
  if (!d) {
    const r = p.render(src, { fontFamily: font, idPrefix: `cbmmd${++n}-`, ...(max ? { maxWidth: max } : {}) });
    d = { svg: r.svg, width: r.width };
    drawn.set(key, d);
  }
  return d;
}

/** 按 box 现在的宽度画（宽度、字体都没变就不动） */
function fit(p: P, box: HTMLElement, w: number, font: string) {
  const src = box.dataset.src ?? "";
  try {
    const own = draw(p, src, font, 0);
    const max = own.width <= w ? 0 : Math.max(STEP, Math.floor(w / STEP) * STEP);
    const key = `${font}\n${max}`;
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = max ? draw(p, src, font, max).svg : own.svg;
    box.classList.add("ok");
  } catch (e) {
    if (box.dataset.key === "err") return;
    box.dataset.key = "err";
    const err = document.createElement("div");
    err.className = "mmd-err";
    err.textContent = `Mermaid: ${String((e as Error)?.message ?? e).split("\n").slice(0, 3).join(" ")}`;
    box.prepend(err);
  }
}

/** 排进下一轮量 DOM：先读宽度，再画（宽度是 0 = 没显示出来，先不画） */
function queueFit(p: P, box: HTMLElement) {
  queueMeasure(box, () => {
    const w = box.clientWidth;
    if (!w) return;
    return () => fit(p, box, w, fontOf());
  });
}

// 换主题（html 的 data-look）后字体可能变了：画好的图都按新字体再对一遍
let watching = false;
function watchLook(p: P) {
  if (watching) return;
  watching = true;
  let t: number | undefined;
  new MutationObserver(() => {
    clearTimeout(t);
    t = window.setTimeout(() => { for (const box of document.querySelectorAll<HTMLElement>(".mmd[data-done]")) queueFit(p, box); }, 50); // 等主题的样式落定再取字体
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-look"] });
}

/** 把 el 里的 .mmd 占位换成图；之后 Note 宽度变了跟着重排 */
export async function renderAll(el: HTMLElement) {
  const boxes = [...el.querySelectorAll<HTMLElement>(".mmd:not([data-done])")];
  if (!boxes.length) return;
  const p = (lib ??= await import("pele"));
  watchLook(p);
  await document.fonts?.ready; // 字宽按真字体量：字体还在加载时量到的是后备字体
  for (const box of boxes) {
    if (!box.isConnected || box.dataset.done) continue;
    box.dataset.done = "1";
    let w = -1;
    const stop = observeResize(box, () => {
      if (!box.isConnected) { stop(); return; } // Note 重新渲染换掉了这块
      if (box.clientWidth === w) return; // 只是图换了以后变高
      w = box.clientWidth;
      queueFit(p, box);
    });
    queueFit(p, box);
  }
}
