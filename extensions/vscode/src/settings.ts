// 设置：存在 VS Code 配置 codeboard.* 里（用户级），白板设置页读写同一份。
import * as vscode from "vscode";
import { DEFAULT_SETTINGS, type Settings } from "@codeboard/core";

/** Settings 字段 → 配置键 */
const KEY: Record<keyof Settings, string> = {
  theme: "theme",
  hideOnNew: "newCards.hide",
  studyScope: "studyScope",
  stickerDir: "stickerFolder",
  zoomOverview: "zoom.overview",
  zoomMap: "zoom.map",
  dblClick: "doubleClick",
  themeReflow: "themeReflow", // not "theme.reflow": codeboard.theme is a string, so VS Code ignores keys under it
  hideNumbers: "flowNumbers.hide",
  debug: "debug.enabled",
  tune: "debug.tune",
};

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("codeboard");
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of Object.keys(KEY) as (keyof Settings)[]) {
    const v = c.get(KEY[k]);
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as Settings;
}

export async function writeSetting(k: keyof Settings, v: unknown) {
  if (!(k in KEY)) return;
  await vscode.workspace.getConfiguration("codeboard").update(KEY[k], v, vscode.ConfigurationTarget.Global);
}

export const affectsSettings = (e: vscode.ConfigurationChangeEvent) => (Object.values(KEY) as string[]).some((k) => e.affectsConfiguration(`codeboard.${k}`));
