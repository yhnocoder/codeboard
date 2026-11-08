// Custom sticker packs, the pure part: the Sticker Packs folder's Iconify JSON files (one set each) and icon folders (folder name
// = pack name), read through PackFiles so a shell without Node (the macOS app) reads the same packs. Folders hold SVGs or
// bitmaps (PNG / WebP / GIF, animated too): bitmaps are told by their bytes (core sniffImage; the extension only picks the
// files) and go to the board as data: URLs.
import { sniffImage, type StickerIcon, type StickerPack } from "@codeboard/core";
import * as v from "valibot";
import type { DirEnt } from "./storage/fs";

/** What reading the packs needs of a file system (Node's here; the macOS app's own in packsIn): a shell without Node reads
 *  the same packs */
export type PackFiles = {
  readdir(dir: string): Promise<DirEnt[]>;
  size(p: string): Promise<number>;
  text(p: string): Promise<string>;
  bytes(p: string): Promise<Uint8Array>;
  toBase64(b: Uint8Array): string;
  join(...parts: string[]): string;
};
/** 单个 SVG 的大小上限：更大的跳过（清洗在白板里用 DOMPurify 做，宿主只读文件） */
export const MAX_SVG = 256 * 1024;
/** 单个位图（PNG / WebP / GIF）的大小上限：更大的跳过。128px 的动图表情一般几十到几百 KB */
export const MAX_BITMAP = 2 * 1024 * 1024;
/** 一个文件夹里位图加起来的上限：整包一次发给白板，超出以后的跳过 */
const MAX_PACK_BITMAPS = 32 * 1024 * 1024;
/** Iconify JSON 整个文件的上限（一整套图标通常几 MB） */
const MAX_JSON = 64 * 1024 * 1024;
const BITMAP_EXT = /\.(png|webp|gif)$/i;
const ICON_EXT = /\.(svg|png|webp|gif)$/i;

// An Iconify icon set (the part we read): https://iconify.design/docs/types/iconify-json.html
const Box = {
  left: v.optional(v.number()),
  top: v.optional(v.number()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
};
const IconifyJson = v.object({
  prefix: v.optional(v.string()),
  info: v.optional(v.object({ name: v.optional(v.string()) })),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  icons: v.record(v.string(), v.object({ body: v.optional(v.string()), ...Box })),
});

function iconifyPack(id: string, raw: unknown): StickerPack | null {
  const r = v.safeParse(IconifyJson, raw);
  if (!r.success) return null;
  const j = r.output,
    W = j.width ?? 16,
    H = j.height ?? 16;
  const icons = Object.entries(j.icons)
    .map(([name, ic]) => ({
      name,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ic.left ?? 0} ${ic.top ?? 0} ${ic.width ?? W} ${ic.height ?? H}">${ic.body ?? ""}</svg>`,
    }))
    .filter((ic) => ic.svg.length <= MAX_SVG);
  return { id, name: j.info?.name ?? j.prefix ?? id, icons };
}

/** 文件夹包：图标名 = 文件名去掉扩展名（白板文件里贴纸只记包名 + 图标名）；同名的 SVG 和位图只留一个，SVG 优先 */
async function folderPack(
  fs: PackFiles,
  warn: (s: string) => void,
  dir: string,
  id: string,
): Promise<StickerPack | null> {
  const isBitmap = (f: string) => Number(BITMAP_EXT.test(f));
  const files = (await fs.readdir(dir))
    .map((e) => e.name)
    .filter((f) => ICON_EXT.test(f))
    .sort((a, b) => isBitmap(a) - isBitmap(b) || a.localeCompare(b));
  const icons: StickerIcon[] = [],
    seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const fp = fs.join(dir, f),
      name = f.replace(ICON_EXT, "");
    if (seen.has(name)) {
      warn(`sticker ${fp}: the pack already has an icon named ${name}, skipped`);
      continue;
    }
    try {
      const size = await fs.size(fp);
      if (!isBitmap(f)) {
        if (size > MAX_SVG) {
          warn(`sticker ${fp}: larger than ${MAX_SVG >> 10} KB, skipped`);
          continue;
        }
        icons.push({ name, svg: (await fs.text(fp)).trim() });
      } else {
        if (size > MAX_BITMAP) {
          warn(`sticker ${fp}: larger than ${MAX_BITMAP >> 20} MB, skipped`);
          continue;
        }
        if (total + size > MAX_PACK_BITMAPS) {
          warn(`sticker ${fp}: the pack's images pass ${MAX_PACK_BITMAPS >> 20} MB, skipped`);
          continue;
        }
        const buf = await fs.bytes(fp);
        const t = sniffImage(buf);
        if (!t || t.mime === "image/jpeg") {
          warn(`sticker ${fp}: not a PNG, WebP or GIF image, skipped`);
          continue;
        }
        total += buf.length;
        const img = `data:${t.mime};base64,${fs.toBase64(buf)}`;
        icons.push(t.anim ? { name, img, anim: true } : { name, img });
      }
      seen.add(name);
    } catch (err) {
      warn(`sticker ${fp}: ${(err as Error).message}`);
    }
  }
  icons.sort((a, b) => a.name.localeCompare(b.name));
  return icons.length ? { id, name: id, icons } : null;
}

/** The packs in a folder, through the file port (a shell without Node passes its own) */
export async function packsIn(dir: string, fs: PackFiles, warn: (s: string) => void): Promise<StickerPack[]> {
  const ents = await fs.readdir(dir).catch(() => []);
  const out: StickerPack[] = [];
  for (const e of ents) {
    const p = fs.join(dir, e.name);
    try {
      if (e.isFile && e.name.endsWith(".json")) {
        if ((await fs.size(p)) > MAX_JSON) {
          warn(`sticker pack ${p}: larger than ${MAX_JSON >> 20} MB, skipped`);
          continue;
        }
        const pk = iconifyPack(e.name.replace(/\.json$/, ""), JSON.parse(await fs.text(p)));
        if (pk) out.push(pk);
      } else if (e.isDir) {
        const pk = await folderPack(fs, warn, p, e.name);
        if (pk) out.push(pk);
      }
    } catch (err) {
      warn(`sticker pack ${p}: ${(err as Error).message}`);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
