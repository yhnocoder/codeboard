import { DEFAULT_SETTINGS, type Settings } from "@codeboard/core";
import { HOST_SETTINGS, SETTINGS, type HostSetting } from "@codeboard/core/settings";
import type { HostContext } from "./context";

const KEY = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.key])) as Record<keyof Settings, string>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const validSetting = (k: string, v: unknown): k is keyof Settings =>
  k in SETTINGS && SETTINGS[k as keyof Settings].valid(v);

/**
 * 白板改了、还没写完的设置（写一次 settings.json 要一两百毫秒）。连着改（点两个主题、按住字号的箭头）时，前一次写完的改动事件
 * 广播出去的设置里这一项还是前一个值，白板会先跳回去再跳回来：这期间读设置用最后要写的值
 */
export class SettingWrites {
  private writes = new Map<string, { v: unknown }>();

  /** The value last asked to be written for k, while that write is still going */
  pending(k: string): { v: unknown } | undefined {
    return this.writes.get(k);
  }

  async run(k: string, v: unknown, write: () => Promise<void>) {
    const w = { v };
    this.writes.set(k, w);
    try {
      await write();
    } finally {
      if (this.writes.get(k) === w) this.writes.delete(k);
    }
  }
}

/** One setting, the way the board gets it in readSettings */
export function readSetting<K extends keyof Settings>(cx: HostContext, k: K): Settings[K] {
  const w = cx.settingWrites.pending(k);
  const v = w ? w.v : cx.ws.settings.get(`codeboard.${KEY[k]}`);
  const d: unknown = DEFAULT_SETTINGS[k];
  if (v === undefined || v === null) return d as Settings[K];
  // 对象设置（newCards.hide、notes.fontSize）：settings.json 里只写了几项时，其余的取默认值，白板拿到的总是每项都在的完整对象
  return (isObj(d) && isObj(v) ? { ...d, ...v } : v) as Settings[K];
}

export function readSettings(cx: HostContext): Settings {
  const out = {} as Record<keyof Settings, unknown>;
  for (const k of Object.keys(KEY) as (keyof Settings)[]) out[k] = readSetting(cx, k);
  return out as Settings;
}

/** A setting only the host reads (core's HOST_SETTINGS); undefined when not set */
export const readHostSetting = <T>(cx: HostContext, k: HostSetting): T | undefined =>
  cx.ws.settings.get<T>(`codeboard.${HOST_SETTINGS[k].key}`);

/** 跟着项目走的设置：从白板改时写进工作区设置，不写用户设置（公式预设里的命令通常是这个项目的记号） */
const PROJECT = new Set<keyof Settings>(["mathPreamble"]);

export async function writeSetting(cx: HostContext, k: keyof Settings, v: unknown) {
  if (!(k in KEY)) return;
  if (!validSetting(k, v)) {
    cx.log("warn", `setSetting: ignored bad value for ${k}: ${JSON.stringify(v)?.slice(0, 200)}`);
    return;
  }
  await cx.settingWrites.run(k, v, () =>
    cx.ws.settings.set(`codeboard.${KEY[k]}`, v, PROJECT.has(k) ? "workspace" : "user"),
  );
}

export const affectsSettings = (e: { affects(key: string): boolean }) =>
  (Object.values(KEY) as string[]).some((k) => e.affects(`codeboard.${k}`));
