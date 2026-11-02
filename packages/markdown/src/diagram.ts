// 颜色是 SVG 里的 CSS 变量（markdown.css 的 .mmd 把 --pele-* 接到主题变量上），换明暗、换配色都不用重画。
// 图比 Note 宽就给 pele 宽度上限（maxWidth），它改成竖着排，字不缩小；放得下了再换回原来的方向
import type { Measure } from "./ui/measure";
import { capped } from "./cache";

type P = typeof import("pele");
const STEP = 40; // 宽度上限按 40px 分档：拖 Note 边时不用每个像素都重新排
const MAX = 200;

const fontOf = () => getComputedStyle(document.documentElement).getPropertyValue("--sys").trim();

/** One Markdown instance's Mermaid diagrams: drawn once per source, font and width step, laid out in the page's measuring round */
export class Diagrams {
  private drawn = new Map<string, { svg: string; width: number }>();
  private n = 0;
  private watching = false;
  /** Marks the boxes this instance drew (data-done), so a theme change refits only those; and its SVG ids, unique on the page */
  private id = Math.random().toString(36).slice(2, 8);

  constructor(
    private p: P,
    private measure: Measure,
  ) {}

  private draw(src: string, font: string, max: number) {
    const key = `${font}\n${max}\n${src}`;
    let d = this.drawn.get(key);
    if (!d) {
      const r = this.p.render(src, {
        fontFamily: font,
        idPrefix: `cbmmd${this.id}-${++this.n}-`,
        ...(max ? { maxWidth: max } : {}),
      });
      d = { svg: r.svg, width: r.width };
      capped(this.drawn, MAX, key, d);
    }
    return d;
  }

  private fit(box: HTMLElement, w: number, font: string) {
    const src = box.dataset.src ?? "";
    try {
      const own = this.draw(src, font, 0);
      const max = own.width <= w ? 0 : Math.max(STEP, Math.floor(w / STEP) * STEP);
      const key = `${font}\n${max}`;
      if (box.dataset.key === key) return;
      box.dataset.key = key;
      box.innerHTML = max ? this.draw(src, font, max).svg : own.svg;
      box.classList.add("ok");
    } catch (e) {
      if (box.dataset.key === "err") return;
      box.dataset.key = "err";
      const err = document.createElement("div");
      err.className = "mmd-err";
      err.textContent = `Mermaid: ${String((e as Error)?.message ?? e)
        .split("\n")
        .slice(0, 3)
        .join(" ")}`;
      box.prepend(err);
    }
  }

  private queueFit(box: HTMLElement) {
    this.measure.queue(box, () => {
      const w = box.clientWidth;
      if (!w) return;
      return () => this.fit(box, w, fontOf());
    });
  }

  // 主题（html 的 data-look）带着字体：换了以后画好的图都按新字体再对一遍
  private watchLook() {
    if (this.watching) return;
    this.watching = true;
    new MutationObserver(() => {
      const refit = () => {
        for (const box of document.querySelectorAll<HTMLElement>(`.mmd[data-done="${this.id}"]`)) this.queueFit(box);
      };
      // 新主题的字体可能还没下载：按后备字体量出来的字宽不对
      document.fonts.load(`1em ${fontOf()}`).then(refit, refit);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-look"] });
  }

  async renderAll(el: HTMLElement) {
    const boxes = [...el.querySelectorAll<HTMLElement>(".mmd:not([data-done])")];
    if (!boxes.length) return;
    this.watchLook();
    await document.fonts?.ready; // 字宽按真字体量：字体还在加载时量到的是后备字体
    for (const box of boxes) {
      if (!box.isConnected || box.dataset.done) continue;
      box.dataset.done = this.id;
      let w = -1;
      const stop = this.measure.observe(box, () => {
        if (!box.isConnected) {
          stop();
          return;
        } // Note 重新渲染换掉了这块
        if (box.clientWidth === w) return; // 只是换了图以后变高
        w = box.clientWidth;
        this.queueFit(box);
      });
      this.queueFit(box);
    }
  }
}

/** Diagrams drawn with pele, loaded on the first one */
export const diagrams = async (measure: Measure) => new Diagrams(await import("pele"), measure);
