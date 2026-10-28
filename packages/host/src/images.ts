// Note 里粘贴、拖进来、/Image 选的图：宿主存成存储目录 assets/ 里的文件，Note 的 Markdown 只写相对地址 assets/<文件名>（不写 base64）。
// assets/ 和白板文件、卡库 cards/ 在同一个存储目录里：同一个工作区的白板、共享卡都认这个地址；webview 里由 host.assetBase 换成资源地址。
// 只收 PNG / JPEG / WebP / GIF / SVG，按内容认（不信扩展名和 mime）；文件名 = 内容的 sha1 前 16 位 + 显示的宽高：同一张图只存一份，
// 白板不用先解码就知道它多大（显示、编辑时先留好位置，切换时不跳）
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IMAGE_EXT, sniffImage, sniffSvg } from "@codeboard/core";
import type { Storage } from "./storage";
import { workspace } from "./ws";

export const MAX_NOTE_IMAGE = 10 * 1024 * 1024;
/** Markdown 里写的地址的前缀（相对存储目录） */
export const ASSET_PREFIX = "assets/";

/** 存一张 data: URL 的图，回 Markdown 里写的地址（assets/<sha1 前 16 位>-<宽>x<高>.<扩展名>）；不是这几种图、太大时抛错（消息给用户看） */
export async function saveNoteImage(store: Storage, dataUrl: string): Promise<string> {
  const m = /^data:[^,;]*(;[^,]*)?;base64,/.exec(dataUrl);
  if (!m) throw new Error("Not an image");
  // base64 每 4 个字 3 个字节：先按长度挡掉太大的，不解码
  if (((dataUrl.length - m[0].length) * 3) / 4 > MAX_NOTE_IMAGE + 3) throw new Error(`Image is larger than ${MAX_NOTE_IMAGE >> 20} MB`);
  const buf = Buffer.from(dataUrl.slice(m[0].length), "base64");
  if (buf.length > MAX_NOTE_IMAGE) throw new Error(`Image is larger than ${MAX_NOTE_IMAGE >> 20} MB`);
  // SVG 原样存成 .svg（矢量，放大也清楚）：Note 里的图只用 <img> 显示，SVG 里的脚本不会跑
  const t = sniffImage(buf), svg = t ? null : sniffSvg(buf);
  if (!t && !svg) throw new Error("Only PNG, JPEG, WebP, GIF and SVG images can go into a Note");
  const sha = createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const file = t ? `${sha}-${t.w}x${t.h}.${IMAGE_EXT[t.mime]}` : svg!.w ? `${sha}-${svg!.w}x${svg!.h}.svg` : `${sha}.svg`;
  await store.putAsset(file, buf);
  return ASSET_PREFIX + file;
}

/** Image 卡的图（assets/ 里的文件名）读成 data: URL：复制到剪贴板、拖进 Note 时白板要图的内容（webview 不能 fetch 资源地址）。认不出、太大时抛错 */
export async function readAsset(store: Storage, file: string): Promise<string> {
  if (!/^[\w.-]+$/.test(file) || file.startsWith(".")) throw new Error(`Bad asset name ${file}`);
  const abs = path.join(store.assetsDir(), file);
  if ((await fs.stat(abs)).size > MAX_NOTE_IMAGE) throw new Error(`Image is larger than ${MAX_NOTE_IMAGE >> 20} MB`);
  const buf = await fs.readFile(abs);
  const mime = sniffImage(buf)?.mime ?? (sniffSvg(buf) ? "image/svg+xml" : null);
  if (!mime) throw new Error("Not an image");
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * 拖到白板上、只给了 URI 的图片文件（VS Code 资源管理器里拖来的，或系统拖放只带 URI 的）读成 data: URL，交给白板照粘贴的图存。
 * 经编辑器读（工作区外的 file:、远程的 vscode-remote: 都行）；认不出、太大时抛错（消息给用户看）
 */
export async function readImageUri(uri: string): Promise<string> {
  const name = decodeURIComponent(uri.replace(/[?#].*$/, "").split("/").pop() || uri);
  const bytes = await workspace().files.readBytes(uri, MAX_NOTE_IMAGE).catch(() => { throw new Error(`Could not read ${name}`); });
  if (!bytes) throw new Error(`${name} is larger than ${MAX_NOTE_IMAGE >> 20} MB`);
  const buf = Buffer.from(bytes);
  const mime = sniffImage(buf)?.mime ?? (sniffSvg(buf) ? "image/svg+xml" : null);
  if (!mime) throw new Error(`${name} is not a PNG, JPEG, WebP, GIF or SVG image`);
  return `data:${mime};base64,${buf.toString("base64")}`;
}
