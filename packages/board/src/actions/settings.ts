// 设置页、主题、诊断：设置改了先乐观更新本地 state.host.settings，再让宿主写进 codeboard.*（宿主会再广播回来）。
import type { Settings } from "@codeboard/core";
import { setState } from "../state/store";
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
  if (el.dataset.look !== (id ?? "warm-ink")) el.dataset.look = id ?? "warm-ink";
}

/** Copy Diagnostics（⋯ 菜单用）：宿主收集版本、工作区、日志，问要不要附上白板 JSON */
export function copyDiagnostics() {
  send({ type: "copyDiagnostics" });
}

