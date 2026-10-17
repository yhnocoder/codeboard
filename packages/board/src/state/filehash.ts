// 不依赖白板状态的小函数，单测直接引
/** 源文件路径 → 0–359 的色相（Blocks 每个文件一种颜色）。只看路径本身：同一个文件在哪块白板、哪台机器上都是同一种颜色。
 *  FNV-1a 散列：名字只差一个字母的文件也分得开 */
export function fileHash(path: string | undefined): number | undefined {
  if (!path) return undefined;
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % 360;
}
