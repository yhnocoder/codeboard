// 设置页、主题、诊断：设置改了先乐观更新本地 state.host.settings，再让宿主写进 codeboard.*（宿主会再广播回来）。
import type { Settings } from "@codeboard/core";
import { setState, state, placed, rectOf, mutate } from "../state/store";
import { settingsOpen, setSettingsOpen, setKeysOpen } from "../state/ui";
import { send } from "../host";

export { settingsOpen };

/** 打开 Settings 页；section = "shortcuts" 等直接滚到那一节 */
export function openSettings(section?: string) {
  setKeysOpen(false);
  setSettingsOpen({ section });
}
export const closeSettings = () => setSettingsOpen(false);
export const toggleSettings = () => (settingsOpen() ? closeSettings() : openSettings());

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  setState("host", "settings", key, value as never);
  send({ type: "setSetting", key, value });
}

/** 材质主题挂在 html[data-look]（明暗是 html[data-theme]，跟随 VS Code）。只改属性 = 只重算样式 */
export function applyLook(id: string | undefined) {
  const el = document.documentElement;
  if (el.dataset.look === (id ?? "warm-ink")) return;
  const first = !el.dataset.look;
  const before = first ? null : new Map(placed().map((k) => [k.id, rectOf(k)]));
  el.dataset.look = id ?? "warm-ink";
  // 卡头 / 色带高度跟主题变：等新尺寸量完（两帧），把被压住的卡往下推（设置里可以改成允许重叠）
  if (before && state.host.settings?.themeReflow !== "overlap") requestAnimationFrame(() => requestAnimationFrame(() => reflowAfterTheme(before)));
}

type R = { x: number; y: number; w: number; h: number };
/** 换主题后：原来不重叠的上下两张卡，上面那张变高压住了下面那张 → 下面那张（连同更下面的）往下挪，间距保持原样（最多 24） */
export function reflowAfterTheme(before: Map<string, R>) {
  const ids = [...before.keys()].filter((id) => state.board.place[id]).sort((a, b) => before.get(a)!.y - before.get(b)!.y);
  const now = new Map(ids.map((id) => [id, rectOf(id)]));
  const dy = new Map<string, number>();
  for (const b of ids) {
    const B0 = before.get(b)!;
    let need = 0;
    for (const a of ids) {
      if (a === b) continue;
      const A0 = before.get(a)!, A1 = now.get(a)!;
      if (A0.y >= B0.y || A0.x >= B0.x + B0.w || B0.x >= A0.x + A0.w) continue; // 只看上面、横向有重叠的
      const gap = B0.y - (A0.y + A0.h);
      if (gap < 0) continue; // 原来就叠着：不管
      const bottom = A0.y + (dy.get(a) ?? 0) + A1.h + Math.min(gap, 24);
      need = Math.max(need, bottom - B0.y);
    }
    if (need > 0.5) dy.set(b, Math.round(need));
  }
  if (!dy.size) return;
  mutate((bd) => { for (const [id, d] of dy) bd.place[id].y += d; });
}

/** Copy Diagnostics（⋯ 菜单用）：宿主收集版本、工作区、日志，问要不要附上白板 JSON */
export function copyDiagnostics() {
  send({ type: "copyDiagnostics" });
}

