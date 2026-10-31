// 调试用的常量：平时用默认值；VS Code 设置 codeboard.debug 打开后，设置页多一节 Debug 可以现调（存在 codeboard.debug.tune）
import { state } from "./store";
import { DBL_CLICK, LIFT_FADE, LINK_LEAVE, MENU_OPEN, PEEK_DELAY, PEEK_HIDE, SIDE_SLIDE, SNAP_SPEED } from "./timing";

export const TUNE = {
  peekDelay: { def: PEEK_DELAY, label: "Peek: hover delay", unit: "ms", min: 100, max: 3000 },
  peekStill: { def: 4, label: "Peek: max mouse wobble while waiting", unit: "px", min: 0, max: 30 },
  peekHide: { def: PEEK_HIDE, label: "Peek: hide after leaving", unit: "ms", min: 0, max: 2000 },
  linkLeave: { def: LINK_LEAVE, label: "Arrow hover: keep after leaving", unit: "ms", min: 0, max: 2000 },
  dblClick: { def: DBL_CLICK, label: "Double-click window", unit: "ms", min: 150, max: 800 },
  snap: { def: 6, label: "Snap distance", unit: "px", min: 0, max: 30 },
  snapSpeed: { def: SNAP_SPEED, label: "No snapping while dragging faster than", unit: "px/s", min: 100, max: 5000 },
  sideBuffer: { def: 16, label: "Arrows: distance before an end switches sides", unit: "px", min: 0, max: 80 },
  sideSlide: { def: SIDE_SLIDE, label: "Arrows: end slide when switching sides", unit: "ms", min: 0, max: 1000 },
  liftFade: {
    def: LIFT_FADE,
    label: "Arrows: fade when lifting above / dropping below cards",
    unit: "ms",
    min: 0,
    max: 1000,
  },
  menuOpen: { def: MENU_OPEN, label: "Menu open animation", unit: "ms", min: 0, max: 600 },
  animSpeed: { def: 100, label: "All animations speed (slow motion)", unit: "%", min: 5, max: 100 },
} as const;
export type TuneKey = keyof typeof TUNE;

export function tune(k: TuneKey): number {
  const v = state.host.settings.tune[k];
  return typeof v === "number" && isFinite(v) ? v : TUNE[k].def;
}
