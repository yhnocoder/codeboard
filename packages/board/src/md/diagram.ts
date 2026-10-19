// Mermaid 图：页面上有 ```mermaid 块时才加载 pele（Mermaid 语法 → SVG，同步、没有依赖）。
// 颜色是 SVG 里的 CSS 变量（styles.css 的 .mmd 把 --pele-* 接到主题变量上），换明暗、换主题配色都不用重画；
// 布局要量字宽，跟字体有关：SVG 按「字体 + 源码」缓存，换了字体的主题才重画
type P = typeof import("pele");
let lib: Promise<P> | undefined;
const svgs = new Map<string, string>();
let n = 0;

const fontOf = () => getComputedStyle(document.documentElement).getPropertyValue("--sys").trim();

function svgOf(p: P, src: string, font: string): string {
  const key = `${font}\n${src}`;
  let svg = svgs.get(key);
  if (svg === undefined) {
    svg = p.render(src, { fontFamily: font, idPrefix: `cbmmd${++n}-` }).svg;
    svgs.set(key, svg);
  }
  return svg;
}

// 换主题（html 的 data-look）后字体可能变了：已经画好的、字体不一样的图重画
let watching = false;
function watchLook() {
  if (watching) return;
  watching = true;
  let t: number | undefined;
  new MutationObserver(() => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      const font = fontOf(), hosts = new Set<HTMLElement>();
      for (const box of document.querySelectorAll<HTMLElement>(".mmd[data-done]")) {
        if (box.dataset.font === font) continue;
        delete box.dataset.done;
        if (box.parentElement) hosts.add(box.parentElement);
      }
      for (const h of hosts) void renderAll(h);
    }, 50); // 等主题的样式落定再取字体
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-look"] });
}

/** 把 el 里的 .mmd 占位换成图 */
export async function renderAll(el: HTMLElement) {
  watchLook();
  const boxes = [...el.querySelectorAll<HTMLElement>(".mmd:not([data-done])")];
  if (!boxes.length) return;
  const p = await (lib ??= import("pele"));
  await document.fonts?.ready; // 字宽按真字体量：字体还在加载时量到的是后备字体
  const font = fontOf();
  for (const box of boxes) {
    if (!box.isConnected || box.dataset.done) continue;
    box.dataset.done = "1";
    box.dataset.font = font;
    const src = box.dataset.src ?? "";
    try {
      box.innerHTML = svgOf(p, src, font);
      box.classList.add("ok");
    } catch (e) {
      const err = document.createElement("div");
      err.className = "mmd-err";
      err.textContent = `Mermaid: ${String((e as Error)?.message ?? e).split("\n").slice(0, 3).join(" ")}`;
      box.querySelector(".mmd-err")?.remove();
      box.prepend(err);
    }
  }
}
