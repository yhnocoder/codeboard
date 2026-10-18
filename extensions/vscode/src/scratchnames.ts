// 编辑中的代码对应的隐藏文件（src/vscode/scratch.ts）的命名和崩溃后的清理规则。纯函数，不碰 vscode 也不碰磁盘，测试见 test/scratch-names.ts。
// 文件名只能是 .codeboard-scratch-<id>.<ext>：<id> 是 sanitizeId 之后的 [\w-]+，<ext> 是语言表（core langs.ts）里某个语言新建文件用的扩展名。
// 用户自己的 .codeboard-notes.md、.codeboard-config、别的功能的 .codeboard-ref 都对不上。
// 另一个 VS Code 窗口可能正在用同一个目录（同一个仓库、同一个 Note 目录）：打开期间每分钟刷一次文件的 mtime（心跳），
// 清理只删 mtime 超过 STALE_MS 的文件，所以别的窗口还在用的文件不会被删。
import { LANG_TABLE, langInfo } from "@codeboard/core";

export const SCRATCH_PREFIX = ".codeboard-scratch-";
/** .git/info/exclude 里写的那一行 */
export const SCRATCH_GLOB = `${SCRATCH_PREFIX}*`;
/** 打开期间多久刷一次 mtime */
export const HEARTBEAT_MS = 60_000;
/** mtime 比这个还旧的才算是没人用的（崩了、窗口被杀掉留下的） */
export const STALE_MS = 10 * 60_000;

/** 语言新建文件用的扩展名（语言表里没有扩展名的语言写成 txt） */
const extOf = (lang: string) => langInfo(lang)?.ext[0] ?? "txt";
const EXTS = [...new Set([...LANG_TABLE.map((l) => extOf(l.id)), "txt"])];
const NAME = new RegExp(`^${SCRATCH_PREFIX.replace(/[.]/g, "\\.")}[\\w-]+\\.(?:${EXTS.join("|")})$`);

export const sanitizeId = (id: string) => id.replace(/[^\w-]/g, "_");
export const scratchName = (id: string, lang: string) => `${SCRATCH_PREFIX}${sanitizeId(id)}.${extOf(lang)}`;
/** 文件名（不带目录）是不是 scratchName 生成的样子 */
export const isScratchName = (name: string) => NAME.test(name);
export const isStale = (mtimeMs: number, now: number) => now - mtimeMs > STALE_MS;

/** 一个目录里该删的：名字对得上、不是自己正在用的、而且很久没人碰过 */
export function staleScratch(entries: { name: string; mtimeMs: number }[], now: number, live: (name: string) => boolean): string[] {
  return entries.filter((e) => isScratchName(e.name) && !live(e.name) && isStale(e.mtimeMs, now)).map((e) => e.name);
}
