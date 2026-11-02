// 自定义贴纸包：Sticker Packs 目录里的 Iconify JSON（一套一个文件）和图标文件夹（文件夹名 = 包名）。纯本地，不联网。
// 文件夹里可以是 SVG，也可以是位图 PNG / WebP / GIF（含动图）：位图按文件头认格式（core 的 sniffImage；扩展名只用来挑文件），读成 data: URL 随包发给白板。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { sniffImage, type StickerIcon, type StickerPack } from "@codeboard/core";
import * as v from "valibot";
import { readSettings } from "./settings";
import type { HostContext } from "./context";

const stickerDir = (cx: HostContext) => {
  const d = readSettings(cx).stickerDir.trim();
  return d ? cx.settingDir(d) : path.join(os.homedir(), ".codeboard", "stickers");
};

export async function openStickerDir(cx: HostContext) {
  const dir = stickerDir(cx);
  try {
    await fs.mkdir(dir, { recursive: true });
    await cx.ws.ui.openFolder(dir);
  } catch (e) {
    cx.log("error", `sticker folder ${dir}: ${e instanceof Error ? e.message : e}`);
    void cx.ws.ui.error(`Cannot open the sticker folder ${dir}`);
  }
}

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
async function folderPack(cx: HostContext, dir: string, id: string): Promise<StickerPack | null> {
  const isBitmap = (f: string) => Number(BITMAP_EXT.test(f));
  const files = (await fs.readdir(dir))
    .filter((f) => ICON_EXT.test(f))
    .sort((a, b) => isBitmap(a) - isBitmap(b) || a.localeCompare(b));
  const icons: StickerIcon[] = [],
    seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const fp = path.join(dir, f),
      name = f.replace(ICON_EXT, "");
    if (seen.has(name)) {
      cx.log("warn", `sticker ${fp}: the pack already has an icon named ${name}, skipped`);
      continue;
    }
    try {
      const size = (await fs.stat(fp)).size;
      if (!isBitmap(f)) {
        if (size > MAX_SVG) {
          cx.log("warn", `sticker ${fp}: larger than ${MAX_SVG >> 10} KB, skipped`);
          continue;
        }
        icons.push({ name, svg: (await fs.readFile(fp, "utf8")).trim() });
      } else {
        if (size > MAX_BITMAP) {
          cx.log("warn", `sticker ${fp}: larger than ${MAX_BITMAP >> 20} MB, skipped`);
          continue;
        }
        if (total + size > MAX_PACK_BITMAPS) {
          cx.log("warn", `sticker ${fp}: the pack's images pass ${MAX_PACK_BITMAPS >> 20} MB, skipped`);
          continue;
        }
        const buf = await fs.readFile(fp);
        const t = sniffImage(buf);
        if (!t || t.mime === "image/jpeg") {
          cx.log("warn", `sticker ${fp}: not a PNG, WebP or GIF image, skipped`);
          continue;
        }
        total += buf.length;
        const img = `data:${t.mime};base64,${buf.toString("base64")}`;
        icons.push(t.anim ? { name, img, anim: true } : { name, img });
      }
      seen.add(name);
    } catch (err) {
      cx.log("warn", `sticker ${fp}: ${(err as Error).message}`);
    }
  }
  icons.sort((a, b) => a.name.localeCompare(b.name));
  return icons.length ? { id, name: id, icons } : null;
}

export async function readPacks(cx: HostContext): Promise<StickerPack[]> {
  const dir = stickerDir(cx);
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: StickerPack[] = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isFile() && e.name.endsWith(".json")) {
        if ((await fs.stat(p)).size > MAX_JSON) {
          cx.log("warn", `sticker pack ${p}: larger than ${MAX_JSON >> 20} MB, skipped`);
          continue;
        }
        const pk = iconifyPack(e.name.replace(/\.json$/, ""), JSON.parse(await fs.readFile(p, "utf8")));
        if (pk) out.push(pk);
      } else if (e.isDirectory()) {
        const pk = await folderPack(cx, p, e.name);
        if (pk) out.push(pk);
      }
    } catch (err) {
      cx.log("warn", `sticker pack ${p}: ${(err as Error).message}`);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
