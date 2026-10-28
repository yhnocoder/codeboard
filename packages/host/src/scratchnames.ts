// 文件名只能是 .codeboard-scratch-<id>.<ext>：<id> 是 sanitizeId 之后的 [\w-]+，<ext> 是语言表（@codeboard/analysis 的 langs.ts）里某个语言新建文件用的扩展名。
// 用户自己的 .codeboard-notes.md、.codeboard-config、别的功能的 .codeboard-ref 都对不上。
// 另一个 VS Code 窗口可能正在用同一个目录（同一个仓库、同一个 Note 目录）：打开期间每分钟刷一次文件的 mtime（心跳），
// 清理只删 mtime 超过 STALE_MS 的文件，所以别的窗口还在用的文件不会被删。
import { LANG_TABLE, langInfo } from "@codeboard/analysis/langs";

export const SCRATCH_PREFIX = ".codeboard-scratch-";
/** .git/info/exclude 里写的那一行 */
export const SCRATCH_GLOB = `${SCRATCH_PREFIX}*`;
export const HEARTBEAT_MS = 60_000;
export const STALE_MS = 10 * 60_000;

const extOf = (lang: string) => langInfo(lang)?.ext[0] ?? "txt";
const EXTS = [...new Set([...LANG_TABLE.map((l) => extOf(l.id)), "txt"])];
const NAME = new RegExp(`^${SCRATCH_PREFIX.replace(/[.]/g, "\\.")}[\\w-]+\\.(?:${EXTS.join("|")})$`);

export const sanitizeId = (id: string) => id.replace(/[^\w-]/g, "_");
export const scratchName = (id: string, lang: string) => `${SCRATCH_PREFIX}${sanitizeId(id)}.${extOf(lang)}`;
export const isScratchName = (name: string) => NAME.test(name);
export const isStale = (mtimeMs: number, now: number) => now - mtimeMs > STALE_MS;

export function staleScratch(entries: { name: string; mtimeMs: number }[], now: number, live: (name: string) => boolean): string[] {
  return entries.filter((e) => isScratchName(e.name) && !live(e.name) && isStale(e.mtimeMs, now)).map((e) => e.name);
}
