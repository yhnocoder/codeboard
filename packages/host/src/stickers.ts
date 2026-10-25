// 自定义贴纸包（#45）：Sticker Packs 目录里的 Iconify JSON（一套一个文件）和图标文件夹（文件夹名 = 包名）。纯本地，不联网。
// 文件夹里可以是 SVG，也可以是位图 PNG / WebP / GIF（含动图，#11）：位图按文件头认格式（扩展名只用来挑文件），读成 data: URL 随包发给白板。
// 目录：设置 Sticker Folder（相对路径相对工作区根），空 = ~/.codeboard/stickers；Open Folder 打开的也是它。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { StickerIcon, StickerPack } from "@codeboard/core";
import { readSettings } from "./settings";
import { log } from "./log";
import { settingDir, workspace } from "./ws";

export const stickerDir = () => {
  const d = readSettings().stickerDir.trim();
  return d ? settingDir(d) : path.join(os.homedir(), ".codeboard", "stickers");
};

/** Open Folder：没有就建，然后在系统文件管理器里打开 */
export async function openStickerDir() {
  const dir = stickerDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await workspace().ui.openFolder(dir);
  } catch (e) {
    log("error", `sticker folder ${dir}: ${e instanceof Error ? e.message : e}`);
    workspace().ui.error(`Cannot open the sticker folder ${dir}`);
  }
}

/** 单个 SVG 的大小上限：更大的跳过（清洗在白板里用 DOMPurify 做，宿主只读文件） */
export const MAX_SVG = 256 * 1024;
/** 单个位图（PNG / WebP / GIF）的大小上限：更大的跳过。128px 的动图表情一般几十到几百 KB */
export const MAX_BITMAP = 2 * 1024 * 1024;
/** 一个文件夹里位图加起来的上限：整包一次发给白板，超出以后的跳过 */
export const MAX_PACK_BITMAPS = 32 * 1024 * 1024;
/** Iconify JSON 整个文件的上限（一整套图标通常几 MB） */
const MAX_JSON = 64 * 1024 * 1024;
const BITMAP_EXT = /\.(png|webp|gif)$/i;
const ICON_EXT = /\.(svg|png|webp|gif)$/i;

/** Iconify JSON → 包 */
export function iconifyPack(id: string, j: any): StickerPack | null {
  if (!j || typeof j.icons !== "object") return null;
  const W = j.width ?? 16, H = j.height ?? 16;
  const icons = Object.entries<any>(j.icons).map(([name, ic]) => ({
    name, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ic.left ?? 0} ${ic.top ?? 0} ${ic.width ?? W} ${ic.height ?? H}">${ic.body ?? ""}</svg>`,
  })).filter((ic) => ic.svg.length <= MAX_SVG);
  return { id, name: j.info?.name ?? j.prefix ?? id, icons };
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/**
 * 按文件头认位图：PNG（含 APNG）、WebP（含动画）、GIF（含多帧）；认不出、或块结构走不通（截断）的返回 null。mime 取自文件头，不看扩展名。
 * 没用库：运行时依赖里没有认文件类型的库，而要看的动图标记（APNG 的 acTL、WebP VP8X 的动画位、GIF 的帧数）通用的库也不管；真正解码在 webview 的图片解码器里
 */
export function sniffImage(b: Uint8Array): { mime: string; anim: boolean } | null {
  // PNG：8 字节签名，第一块是 IHDR；IDAT 之前出现 acTL 就是 APNG
  if (b.length >= 33 && b[0] === 0x89 && ascii(b, 1, 7) === "PNG\r\n\x1a\n" && ascii(b, 12, 4) === "IHDR") {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let anim = false;
    for (let i = 8; i + 8 <= b.length;) {
      const type = ascii(b, i + 4, 4);
      if (type === "acTL") anim = true;
      if (type === "IDAT") return { mime: "image/png", anim };
      i += 12 + dv.getUint32(i);
    }
    return null;
  }
  // WebP：RIFF....WEBP，第一块 VP8 / VP8L（静态）或 VP8X（扩展，标志字节里 0x02 = 动画）
  if (b.length >= 21 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const c = ascii(b, 12, 4);
    if (c === "VP8 " || c === "VP8L") return { mime: "image/webp", anim: false };
    if (c === "VP8X") return { mime: "image/webp", anim: (b[20] & 0x02) !== 0 };
    return null;
  }
  // GIF：GIF87a / GIF89a，走一遍块数帧（0x2C 一帧，0x21 扩展，0x3B 结束）
  if (b.length >= 13 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) {
    const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
    let i = 13 + table(b[10]), frames = 0;
    const skipSub = () => { while (i < b.length && b[i] !== 0) i += b[i] + 1; i++; };
    while (i < b.length && b[i] !== 0x3b) {
      if (b[i] === 0x21) { i += 2; skipSub(); }
      else if (b[i] === 0x2c && i + 10 <= b.length) { i += 10 + table(b[i + 9]) + 1; skipSub(); frames++; } // 图像描述 + 局部色表 + LZW 最小码长 + 数据
      else return null;
    }
    return frames && i <= b.length ? { mime: "image/gif", anim: frames > 1 } : null;
  }
  return null;
}

/** 文件夹包：图标名 = 文件名去掉扩展名（白板文件里贴纸只记包名 + 图标名）；同名的 SVG 和位图只留一个，SVG 优先 */
async function folderPack(dir: string, id: string): Promise<StickerPack | null> {
  const isBitmap = (f: string) => Number(BITMAP_EXT.test(f));
  const files = (await fs.readdir(dir)).filter((f) => ICON_EXT.test(f)).sort((a, b) => isBitmap(a) - isBitmap(b) || a.localeCompare(b));
  const icons: StickerIcon[] = [], seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const fp = path.join(dir, f), name = f.replace(ICON_EXT, "");
    if (seen.has(name)) { log("warn", `sticker ${fp}: the pack already has an icon named ${name}, skipped`); continue; }
    try {
      const size = (await fs.stat(fp)).size;
      if (!isBitmap(f)) {
        if (size > MAX_SVG) { log("warn", `sticker ${fp}: larger than ${MAX_SVG >> 10} KB, skipped`); continue; }
        icons.push({ name, svg: (await fs.readFile(fp, "utf8")).trim() });
      } else {
        if (size > MAX_BITMAP) { log("warn", `sticker ${fp}: larger than ${MAX_BITMAP >> 20} MB, skipped`); continue; }
        if (total + size > MAX_PACK_BITMAPS) { log("warn", `sticker ${fp}: the pack's images pass ${MAX_PACK_BITMAPS >> 20} MB, skipped`); continue; }
        const buf = await fs.readFile(fp);
        const t = sniffImage(buf);
        if (!t) { log("warn", `sticker ${fp}: not a PNG, WebP or GIF image, skipped`); continue; }
        total += buf.length;
        const img = `data:${t.mime};base64,${buf.toString("base64")}`;
        icons.push(t.anim ? { name, img, anim: true } : { name, img });
      }
      seen.add(name);
    } catch (err) { log("warn", `sticker ${fp}: ${(err as Error).message}`); }
  }
  icons.sort((a, b) => a.name.localeCompare(b.name));
  return icons.length ? { id, name: id, icons } : null;
}

export async function readPacks(): Promise<StickerPack[]> {
  const dir = stickerDir();
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: StickerPack[] = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isFile() && e.name.endsWith(".json")) {
        if ((await fs.stat(p)).size > MAX_JSON) { log("warn", `sticker pack ${p}: larger than ${MAX_JSON >> 20} MB, skipped`); continue; }
        const pk = iconifyPack(e.name.replace(/\.json$/, ""), JSON.parse(await fs.readFile(p, "utf8")));
        if (pk) out.push(pk);
      } else if (e.isDirectory()) {
        const pk = await folderPack(p, e.name);
        if (pk) out.push(pk);
      }
    } catch (err) { log("warn", `sticker pack ${p}: ${(err as Error).message}`); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
