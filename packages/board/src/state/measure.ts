// 量 DOM（卡片尺寸、卡里每行的位置）：先把这一轮要量的都读完，再一起写回 store。
// 一边读一边写会让浏览器每张卡都重新排一次版，打开大白板时几百张卡就是几百次排版。
// 还有：指针最后在哪、白板左上角、代码卡的几个固定尺寸、内容本来的大小（Fit Content、改大小时用）
import { batch } from "solid-js";
import { queueMeasure, observeResize, setMeasureBatch } from "@codeboard/markdown/ui";
import { isCode, cardRows, shownText, commonIndent } from "@codeboard/core";
import { state, cardById } from "./store";
import { shown } from "./ui";
import { toWorld } from "./camera";

// 先读后写的一轮测量和共用的 ResizeObserver 在 @codeboard/markdown 里（Mermaid 图的重排也排在同一轮里）：写回包在 batch 里
setMeasureBatch(batch);
export { queueMeasure, observeResize };

// ---------- 指针、白板位置 ----------

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
/** 白板左上角（屏幕坐标） */
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

// ---------- 代码卡的固定尺寸（CSS 里用同一份：App 挂到 body 上的 --gutter、--ded-pad） ----------

/** 行号栏宽 = .src 的左边距 */
export const GUTTER = 54;
/** 藏了公共缩进时代码离左边留的空 */
export const DED_PAD = 16;
let charW = 0;
/** 等宽字体一个字的宽度（量一次） */
export function monoWidth(el: Element) {
  if (charW) return charW;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = getComputedStyle(el).font;
  return (charW = ctx.measureText("0".repeat(100)).width / 100 || 7.2);
}

// ---------- 内容本来的大小 ----------

/** 代码卡的卡头 / 色带 / 底栏一共多高：主题决定，直接量布局。代码卡的 Place.h 存的是中间内容区（.carea）的高度，不含这些 */
export function chromeOf(id: string): number {
  const el = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  const a = el?.querySelector<HTMLElement>(":scope > .cface > .carea");
  return el && a ? el.offsetHeight - a.offsetHeight : 0;
}
/** 卡片内容刚好装下的宽高；minH = 头部 + 一行 */
export function naturalSize(id: string): { w?: number; h: number; minH: number } | null {
  const el = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  if (!el) return null;
  const f = cardById(id);
  const body = el.querySelector<HTMLElement>(".cbody");
  const code = body?.querySelector<HTMLElement>(":scope > .code");
  const head = el.querySelector<HTMLElement>(":scope > .cface > .chead")?.offsetHeight ?? 0;
  if (f && isCode(f.card) && body && code) {
    const src = code.querySelector<HTMLElement>(".src");
    const top = body.offsetTop;
    const h = top + code.offsetHeight + 2;
    let w: number | undefined;
    if (src && !f.card.wrap) {
      const cs = getComputedStyle(src);
      // 只量显示着的行（#25 Linda：藏了 Docstring / 注释 / 空行后，藏掉的长行不该把卡撑宽）：
      // 和 CodeBody 同一套 cardRows；Hide Comments 去掉行尾注释；藏了公共缩进时减掉那几格、加上左边留的空
      const card = f.card;
      const texts = cardRows(card, { views: state.views, shown: shown() }).flatMap((r) => {
        const s = r.t === "line" ? card.segments.find((q) => q.id === r.seg) : undefined;
        return s && r.t === "line" ? [shownText(s, r.line, state.views[s.id], card.hide?.comments)] : [];
      });
      const ded = commonIndent(texts);
      const longest = Math.max(12, ...texts.map((t) => t.trimEnd().length - ded));
      w = Math.ceil(longest * monoWidth(src) + (ded ? DED_PAD : 0) + parseFloat(cs.marginLeft) + parseFloat(cs.paddingRight) + 4);
    }
    return { w, h, minH: top + 6 + 20 + 8 + 2 };
  }
  if (f?.card.kind === "image") {
    const img = el.querySelector("img");
    const w = el.offsetWidth;
    return img?.naturalWidth ? { h: Math.round(head + (w * img.naturalHeight) / img.naturalWidth), minH: head + 40 } : null;
  }
  return { h: el.scrollHeight, minH: head + 30 };
}
