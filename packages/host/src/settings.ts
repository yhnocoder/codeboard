import { DEFAULT_SETTINGS, type Settings } from "@codeboard/core";
import { SETTINGS } from "@codeboard/core/settings";
import { log } from "./log";
import { workspace } from "./ws";

const KEY = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.key])) as Record<keyof Settings, string>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const validSetting = (k: string, v: unknown): k is keyof Settings => k in SETTINGS && SETTINGS[k as keyof Settings].valid(v);

/**
 * 白板改了、还没写完的设置（写一次 settings.json 要一两百毫秒）。连着改（点两个主题、按住字号的箭头）时，前一次写完的改动事件
 * 广播出去的设置里这一项还是前一个值，白板会先跳回去再跳回来：这期间读设置用最后要写的值
 */
const writing = new Map<keyof Settings, { v: unknown }>();

export function readSettings(): Settings {
  const s = workspace().settings;
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of Object.keys(KEY) as (keyof Settings)[]) {
    const w = writing.get(k);
    const v = w ? w.v : s.get(`codeboard.${KEY[k]}`);
    if (v === undefined || v === null) continue;
    // 对象设置（newCards.hide、notes.fontSize）：settings.json 里只写了几项时，其余的取默认值，白板拿到的总是每项都在的完整对象
    const d = DEFAULT_SETTINGS[k];
    out[k] = isObj(d) && isObj(v) ? { ...d, ...v } : v;
  }
  return out as Settings;
}

/** 跟着项目走的设置：从白板改时写进工作区设置，不写用户设置（公式预设里的命令通常是这个项目的记号） */
const PROJECT = new Set<keyof Settings>(["mathPreamble"]);

export async function writeSetting(k: keyof Settings, v: unknown) {
  if (!(k in KEY)) return;
  if (!validSetting(k, v)) { log("warn", `setSetting: ignored bad value for ${k}: ${JSON.stringify(v)?.slice(0, 200)}`); return; }
  const w = { v };
  writing.set(k, w);
  try { await workspace().settings.set(`codeboard.${KEY[k]}`, v, PROJECT.has(k) ? "workspace" : "user"); } finally { if (writing.get(k) === w) writing.delete(k); }
}

export const affectsSettings = (e: { affects(key: string): boolean }) => (Object.values(KEY) as string[]).some((k) => e.affects(`codeboard.${k}`));
