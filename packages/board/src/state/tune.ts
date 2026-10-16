// 调试用的常量：平时用默认值；VS Code 设置 codeboard.debug 打开后，设置页多一节 Debug 可以现调（存在 codeboard.debug.tune）
import { state } from "./store";

export const TUNE = {
  peekDelay: { def: 800, label: "Peek: hover delay", unit: "ms", min: 100, max: 3000 },
  peekStill: { def: 4, label: "Peek: max mouse wobble while waiting", unit: "px", min: 0, max: 30 },
  peekHide: { def: 260, label: "Peek: hide after leaving", unit: "ms", min: 0, max: 2000 },
  linkLeave: { def: 300, label: "Arrow hover: keep after leaving", unit: "ms", min: 0, max: 2000 },
  dblClick: { def: 420, label: "Double-click window", unit: "ms", min: 150, max: 800 },
  snap: { def: 6, label: "Snap distance", unit: "px", min: 0, max: 30 },
  snapSpeed: { def: 700, label: "No snapping while dragging faster than", unit: "px/s", min: 100, max: 5000 },
  menuOpen: { def: 300, label: "Menu open animation", unit: "ms", min: 0, max: 1200 },
} as const;
export type TuneKey = keyof typeof TUNE;

export function tune(k: TuneKey): number {
  const v = state.host?.settings?.tune?.[k];
  return typeof v === "number" && isFinite(v) ? v : TUNE[k].def;
}
