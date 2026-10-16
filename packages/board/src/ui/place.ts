// 浮层定位（@floating-ui/dom）：右键菜单、二级菜单、弹窗共用。
// 边界一律是整个窗口（innerWidth × innerHeight），尺寸用 offset 尺寸：打开动画里 scale < 1 不影响。
import { computePosition, detectOverflow, flip, offset, platform, shift, type Middleware, type Padding, type Placement, type Rect, type VirtualElement } from "@floating-ui/dom";

const view = (): Rect => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
const plat = { ...platform, getDimensions: (el: Element) => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }) };
const bounds = (padding: Padding) => ({ padding, boundary: view(), rootBoundary: view() });

/** 一个点或一个矩形当锚点 */
export const virtual = (r: { x: number; y: number; width?: number; height?: number }): VirtualElement => ({
  getBoundingClientRect: () => { const w = r.width ?? 0, h = r.height ?? 0; return { x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + w, bottom: r.y + h, width: w, height: h }; },
});

/** 主方向放不下就换到另一边（不管那边放不放得下，之后由 shift 推回窗口里） */
const sideFlip = (to: Placement, padding: Padding): Middleware => ({
  name: "sideFlip",
  async fn(s) {
    if (s.placement === to) return {};
    const o = await detectOverflow(s, bounds(padding));
    return o[s.placement.split("-")[0] as "top" | "right" | "bottom" | "left"] > 0 ? { reset: { placement: to } } : {};
  },
});
/** 二级菜单：下边放不下、而从锚点往上放得下，就往上开（和左右翻转互不影响） */
const upIfFits = (padding: { top: number; bottom: number }): Middleware => ({
  name: "upIfFits",
  fn: ({ y, rects }) => {
    const h = rects.floating.height, top = rects.reference.y;
    return y + h > window.innerHeight - padding.bottom && top - h >= padding.top ? { y: top - h } : {};
  },
});

const MENU = { top: 4, left: 4, bottom: 6, right: 6 };

/**
 * 右键菜单：从点 (x, y) 往右下开；下面放不下而上面放得下就往上翻；up = 从 y 往上开（工具栏）。
 * 二级菜单：x 是父项右边，alt 是父菜单左边；右边放不下而左边放得下就开在父菜单左边。最后推回窗口里。
 */
export function placeMenu(el: HTMLElement, p: { x: number; y: number; up?: boolean; alt?: number }) {
  if (p.alt !== undefined) {
    return computePosition(virtual({ x: p.alt + 4, y: p.y, width: p.x - p.alt - 4 }), el, {
      platform: plat, placement: "right-start",
      middleware: [flip({ ...bounds(MENU), crossAxis: false, flipAlignment: false, fallbackPlacements: ["left-start"], fallbackStrategy: "initialPlacement" }), upIfFits(MENU), shift({ ...bounds(MENU), crossAxis: true })],
    });
  }
  return computePosition(virtual(p), el, {
    platform: plat, placement: p.up ? "top-start" : "bottom-start",
    middleware: [...(p.up ? [] : [flip({ ...bounds(MENU), crossAxis: false, fallbackPlacements: ["top-start"], fallbackStrategy: "initialPlacement" })]), shift({ ...bounds(MENU), crossAxis: true })],
  });
}

/**
 * 弹窗：贴着锚点元素，下方（放不下翻到上方）/ 右侧（放不下翻到左侧）/ 上方；没有元素就放在点 (x, y)。离窗口边至少 8px。
 */
export function placePop(el: HTMLElement, ref: Element | VirtualElement, prefer?: "below" | "right" | "above") {
  const keep = shift({ ...bounds(8), crossAxis: true });
  if (!(ref instanceof Element)) return computePosition(ref, el, { platform: plat, placement: "bottom-start", middleware: [keep] });
  if (prefer === "right") return computePosition(ref, el, { platform: plat, placement: "right-start", middleware: [offset({ mainAxis: 8, crossAxis: -6 }), sideFlip("left-start", 8), keep] });
  if (prefer === "above") return computePosition(ref, el, { platform: plat, placement: "top-start", middleware: [offset(6), keep] });
  return computePosition(ref, el, { platform: plat, placement: "bottom-start", middleware: [offset(6), sideFlip("top-start", 8), keep] });
}
