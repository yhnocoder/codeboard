// 浮层定位（@floating-ui/dom）：右键菜单、二级菜单、弹窗、按钮提示、Link List 悬停预览共用。
// 标准的 offset → flip → shift：放不下就翻到另一边，最后推回窗口里。
import { computePosition, flip, offset, shift, type OffsetOptions, type Placement, type Strategy, type VirtualElement } from "@floating-ui/dom";

/** 一个点或一个矩形当锚点 */
export const virtual = (r: { x: number; y: number; width?: number; height?: number }): VirtualElement => ({
  getBoundingClientRect: () => { const w = r.width ?? 0, h = r.height ?? 0; return { x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + w, bottom: r.y + h, width: w, height: h }; },
});

export function place(el: HTMLElement, ref: Element | VirtualElement, placement: Placement, o: { gap?: OffsetOptions; pad?: number; strategy?: Strategy } = {}) {
  const padding = o.pad ?? 8;
  return computePosition(ref, el, {
    placement, strategy: o.strategy,
    middleware: [offset(o.gap ?? 0), flip({ padding }), shift({ padding, crossAxis: true })],
  });
}
