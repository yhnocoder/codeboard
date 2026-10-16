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

/** SVG 进 webview 之前去掉脚本和事件属性 */
export function cleanSvg(s: string): string {
  return s
    .replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/gi, "")
    .replace(/<(script|foreignObject|iframe|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|foreignObject|iframe)\b[^>]*\/>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, "$1#")
    .trim();
}

/** Iconify JSON → 包 */
export function iconifyPack(id: string, j: any): StickerPack | null {
  if (!j || typeof j.icons !== "object") return null;
  const W = j.width ?? 16, H = j.height ?? 16;
  const icons = Object.entries<any>(j.icons).map(([name, ic]) => ({
    name, svg: cleanSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ic.left ?? 0} ${ic.top ?? 0} ${ic.width ?? W} ${ic.height ?? H}">${ic.body ?? ""}</svg>`),
  }));
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
        const pk = iconifyPack(e.name.replace(/\.json$/, ""), JSON.parse(await fs.readFile(p, "utf8")));
        if (pk) out.push(pk);
      } else if (e.isDirectory()) {
        const files = (await fs.readdir(p)).filter((f) => f.endsWith(".svg")).sort();
        const icons = await Promise.all(files.map(async (f) => ({ name: f.replace(/\.svg$/, ""), svg: cleanSvg(await fs.readFile(path.join(p, f), "utf8")) })));
        if (icons.length) out.push({ id: e.name, name: e.name, icons });
      }
    } catch (err) { log("warn", `sticker pack ${p}: ${(err as Error).message}`); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
