// 设置：存在用户设置 codeboard.* 里（用户级），白板设置页读写同一份。
import { DEFAULT_SETTINGS, THEMES, type Settings } from "@codeboard/core";
import { log } from "./log";
import { workspace } from "./ws";

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
  pasteOther: "sharedCards.paste",
  sharedUpdate: "sharedCards.update",
  subPreview: "subBoards.preview",
  welcomeBack: "questions.welcomeBack",
  exportQuestions: "export.includeQuestions",
  exportBoardOnly: "export.includeBoardOnlyNotes",
  exportScope: "export.scope",
  noteHeadingInBody: "notes.headingInBody",
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** 白板发来的值对不对得上 Settings 的类型 */
const VALID: { [K in keyof Settings]-?: (v: unknown) => boolean } = {
  theme: (v) => THEMES.some(([id]) => id === v),
  hideOnNew: (v) => isObj(v) && Object.values(v).every((x) => x === undefined || typeof x === "boolean"),
  studyScope: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  stickerDir: (v) => typeof v === "string",
  zoomOverview: num,
  zoomMap: num,
  dblClick: (v) => v === "text" || v === "note" || v === "code" || v === "none",
  hideNumbers: (v) => typeof v === "boolean",
  themeReflow: (v) => v === "push" || v === "overlap",
  debug: (v) => typeof v === "boolean",
  tune: (v) => (isObj(v) && Object.values(v).every(num)),
  pasteOther: (v) => v === "linked" || v === "copy",
  sharedUpdate: (v) => v === "ask" || v === "all" || v === "this",
  subPreview: (v) => v === "skeleton" || v === "title",
  welcomeBack: (v) => v === "2d" || v === "always" || v === "off",
  exportQuestions: (v) => typeof v === "boolean",
  exportBoardOnly: (v) => typeof v === "boolean",
  exportScope: (v) => v === "board" || v === "sections" || v === "walk",
  noteHeadingInBody: (v) => typeof v === "boolean",
};

export const validSetting = (k: string, v: unknown): k is keyof Settings => k in KEY && VALID[k as keyof Settings](v);

export function readSettings(): Settings {
  const s = workspace().settings;
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of Object.keys(KEY) as (keyof Settings)[]) {
    const v = s.get(`codeboard.${KEY[k]}`);
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as Settings;
}

export async function writeSetting(k: keyof Settings, v: unknown) {
  if (!(k in KEY)) return;
  if (!validSetting(k, v)) { log("warn", `setSetting: ignored bad value for ${k}: ${JSON.stringify(v)?.slice(0, 200)}`); return; }
  await workspace().settings.set(`codeboard.${KEY[k]}`, v);
}

export const affectsSettings = (e: { affects(key: string): boolean }) => (Object.values(KEY) as string[]).some((k) => e.affects(`codeboard.${k}`));
