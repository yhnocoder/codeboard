// 自定义贴纸包（#45）：Sticker Packs 目录里的 Iconify JSON（一套一个文件）和 SVG 文件夹（文件夹名 = 包名）。纯本地，不联网。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { StickerPack } from "@codeboard/core";
import { readSettings } from "./settings";
import { log } from "./log";

export const stickerDir = () => {
  const d = readSettings().stickerDir.trim();
  return d ? d.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), ".codeboard", "stickers");
};

/** 单个 SVG 的大小上限：更大的跳过（清洗在白板里用 DOMPurify 做，宿主只读文件） */
export const MAX_SVG = 256 * 1024;
/** Iconify JSON 整个文件的上限（一整套图标通常几 MB） */
const MAX_JSON = 64 * 1024 * 1024;

/** Iconify JSON → 包 */
export function iconifyPack(id: string, j: any): StickerPack | null {
  if (!j || typeof j.icons !== "object") return null;
  const W = j.width ?? 16, H = j.height ?? 16;
  const icons = Object.entries<any>(j.icons).map(([name, ic]) => ({
    name, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ic.left ?? 0} ${ic.top ?? 0} ${ic.width ?? W} ${ic.height ?? H}">${ic.body ?? ""}</svg>`,
  })).filter((ic) => ic.svg.length <= MAX_SVG);
  return { id, name: j.info?.name ?? j.prefix ?? id, icons };
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
        const files = (await fs.readdir(p)).filter((f) => f.endsWith(".svg")).sort();
        const icons = (await Promise.all(files.map(async (f) => {
          const fp = path.join(p, f);
          if ((await fs.stat(fp)).size > MAX_SVG) { log("warn", `sticker ${fp}: larger than ${MAX_SVG >> 10} KB, skipped`); return null; }
          return { name: f.replace(/\.svg$/, ""), svg: (await fs.readFile(fp, "utf8")).trim() };
        }))).filter((x): x is { name: string; svg: string } => !!x);
        if (icons.length) out.push({ id: e.name, name: e.name, icons });
      }
    } catch (err) { log("warn", `sticker pack ${p}: ${(err as Error).message}`); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
