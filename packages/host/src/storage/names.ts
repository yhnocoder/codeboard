// What may name a board (it is also the file name) and a group (it is the folder name).

export const RESERVED = new Set(["assets", "github", "cards", "runs", ".trash"]);
/** 组名就是子文件夹名：去掉路径符号；"."、".." 和点开头的（.trash）、保留名都不行 */
export function groupName(name: string): string | null {
  const safe = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return safe && !safe.startsWith(".") && !RESERVED.has(safe) ? safe : null;
}
/** 白板 id 也是文件名：只允许字母、数字、- 和 _ */
export const SAFE_ID = /^[\w-]{1,80}$/;
/** A file kept by name right inside assets/ (or runs/, whose ids follow the same rule): letters, digits, _, - and dots, not
 *  starting with a dot, so it can never be a path, "." or "..", or a hidden file */
export function isAssetName(name: string): boolean {
  return /^[\w-][\w.-]*$/.test(name);
}
