// 量 DOM（卡片尺寸、卡里每行的位置）：先把这一轮要量的都读完，再一起写回 store。
// 一边读一边写会让浏览器每张卡都重新排一次版，打开大白板时几百张卡就是几百次排版。
import { batch, createEffect, createRoot } from "solid-js";
import { queueMeasure, observeResize, setMeasureBatch } from "@yhnocoder/markdown/ui";
import { isCode, cardRows, shownText, commonIndent } from "@codeboard/core";
import { state, cardById, sizes } from "./store";
import { visibleCards } from "./sections";
import { shown } from "./ui";
import { toWorld } from "./camera";

// 先读后写的一轮测量和共用的 ResizeObserver 在 @yhnocoder/markdown 里（Mermaid 图的重排也排在同一轮里）：写回包在 batch 里
setMeasureBatch(batch);
export { queueMeasure, observeResize };

/** 看得见的卡都量过尺寸了（刚画出来的卡在 ResizeObserver 第一次报的时候量）；都量过就马上 */
export function cardsMeasured(): Promise<void> {
  return new Promise((done) => createRoot((dispose) => createEffect(() => {
    if (!visibleCards().every((c) => sizes[c.id])) return;
    dispose();
    done();
  })));
}

let lastPtr = { x: 0, y: 0 };
/** 指针最后在哪（屏幕坐标）：installKeys 里开始记 */
export const lastPointer = () => lastPtr;
let down: { x: number; y: number; target: HTMLElement | null } | null = null;
/** 最近一次按下：位置（双击进编辑时光标放在那里）和元素（blur 时判断焦点是不是被同一张卡上的东西拿走的；不可聚焦的地方 relatedTarget 是空的） */
export const lastDown = () => down;
// 白板是 position: fixed 铺满窗口，左上角只在窗口变大小时可能变：记下来，不在每个滚轮 / 指针事件里读布局
// （读 getBoundingClientRect 会让浏览器在事件里先把上一批改动的样式、排版做掉，同一帧里再做一遍）
let boardAt: { x: number; y: number } | null = null;
export function trackPointer() {
  const at = (e: PointerEvent) => { lastPtr = { x: e.clientX, y: e.clientY }; };
  window.addEventListener("pointermove", at, { capture: true, passive: true });
  window.addEventListener("pointerdown", (e) => { at(e); down = { ...lastPtr, target: e.target as HTMLElement | null }; }, { capture: true, passive: true });
  window.addEventListener("resize", () => { boardAt = null; });
}
export function boardOffset() {
  if (boardAt) return boardAt;
  const el = document.getElementById("board");
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  return (boardAt = { x: r.left, y: r.top });
}
/** 屏幕坐标 → 白板里的坐标 / 世界坐标 */
export const boardPoint = (p: { x: number; y: number }) => { const o = boardOffset(); return { x: p.x - o.x, y: p.y - o.y }; };
export const worldAt = (p: { x: number; y: number }) => { const b = boardPoint(p); return toWorld(b.x, b.y); };

// 代码卡的固定尺寸，CSS 里用同一份：BoardView 挂到 body 上的 --ded-pad；行号栏宽 --gutter 在 styles.css 的 .code 上，量 .src 的左边距

/** 藏了公共缩进时代码离左边留的空 */
export const DED_PAD = 16;
/** 没存高度的代码卡（新卡、Fit Content 过的卡）代码区最高多少，更长的在里面滚（BoardView 挂到 body 上的 --code-max） */
export const CODE_MAX = 460;
let charW = 0;
/** 等宽字体一个字的宽度（量一次） */
export function monoWidth(el: Element) {
  if (charW) return charW;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = getComputedStyle(el).font;
  return (charW = ctx.measureText("0".repeat(100)).width / 100 || 7.2);
}

/** 代码卡的卡头 / 色带 / 底栏一共多高：主题决定，直接量布局。代码卡的 Place.h 存的是中间内容区（.carea）的高度，不含这些 */
export function chromeOf(id: string): number {
  const el = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  const a = el?.querySelector<HTMLElement>(":scope > .cface > .carea");
  return el && a ? el.offsetHeight - a.offsetHeight : 0;
}
/** 卡片内容刚好装下的宽高；minH = 头部 + 一行 */
export function naturalSize(id: string): { w?: number; h: number; minH: number; body?: number } | null {
  const el = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  if (!el) return null;
  const f = cardById(id);
  const body = el.querySelector<HTMLElement>(".cbody");
  const code = body?.querySelector<HTMLElement>(":scope > .code");
  const head = el.querySelector<HTMLElement>(":scope > .cface > .chead")?.offsetHeight ?? 0;
  if (f && isCode(f.card) && body && code) {
    const src = code.querySelector<HTMLElement>(".src");
    const top = body.offsetTop, bs = getComputedStyle(body);
    // 代码区自己的边框、内边距，再加上它下面到卡边的那一截（Soft Light 的托盘离卡底 10px）。不算横向滚动条：适配后的宽度放得下最长行
    const frame = parseFloat(bs.borderTopWidth) + parseFloat(bs.borderBottomWidth) + parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom);
    // 自动换行开着时：新的宽度放得下最长行，不会再折行，减掉现在折出来的那几行（每行比一行高多出的部分）
    let wrapped = 0;
    if (src && f.card.wrap) {
      const lh = parseFloat(getComputedStyle(src).lineHeight) || 20;
      for (const l of src.querySelectorAll<HTMLElement>(".l")) wrapped += Math.max(0, l.offsetHeight - lh);
    }
    const h = top + code.offsetHeight - wrapped + frame + Math.max(0, el.offsetHeight - top - body.offsetHeight);
    let w: number | undefined;
    if (src) {
      const cs = getComputedStyle(src);
      // 只量显示着的行（藏了 Docstring / 注释 / 空行后，藏掉的长行不该把卡撑宽）：
      // 和 CodeBody 同一套 cardRows；Hide Comments 去掉行尾注释；藏了公共缩进时减掉那几格、加上左边留的空
      const card = f.card;
      const texts = cardRows(card, { views: state.views, shown: shown() }).flatMap((r) => {
        const s = r.t === "line" ? card.segments.find((q) => q.id === r.seg) : undefined;
        return s && r.t === "line" ? [shownText(s, r.line, state.views[s.id], card.hide?.comments)] : [];
      });
      const ded = commonIndent(texts);
      const longest = Math.max(12, ...texts.map((t) => t.trimEnd().length - ded));
      // 加上代码区外面的那一圈（Soft Light 的托盘离卡边各 10px）：卡比 .cbody 宽多少
      w = Math.ceil(longest * monoWidth(src) + (ded ? DED_PAD : 0) + parseFloat(cs.marginLeft) + parseFloat(cs.paddingRight) + 4 + el.offsetWidth - body.offsetWidth);
    }
    return { w, h, minH: top + 6 + 20 + 8 + 2, body: code.offsetHeight - wrapped + frame };
  }
  if (f?.card.kind === "image") {
    const img = el.querySelector("img");
    // 高度跟着宽度和图片的比例走（不存）：内容本来的大小就是图片自己的宽度
    return img?.naturalWidth ? { w: img.naturalWidth, h: el.offsetHeight, minH: head + 40 } : null;
  }
  // Note / Text：正文定了高度时在自己里面滚（styles.css），整张卡的 scrollHeight 量不到它：正文以上 + 正文的内容 + 卡的下边
  const nb = el.querySelector<HTMLElement>(":scope > .cface > .nbody, :scope > .cface > .tx");
  if (nb) return { h: Math.ceil(nb.offsetTop + nb.scrollHeight + parseFloat(getComputedStyle(el).paddingBottom) + el.clientTop), minH: head + 30 };
  return { h: el.scrollHeight, minH: head + 30 };
}
