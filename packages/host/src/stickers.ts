// 自定义贴纸包：Sticker Packs 目录里的 Iconify JSON（一套一个文件）和图标文件夹（文件夹名 = 包名）。纯本地，不联网。
// 文件夹里可以是 SVG，也可以是位图 PNG / WebP / GIF（含动图）：位图按文件头认格式（core 的 sniffImage；扩展名只用来挑文件），读成 data: URL 随包发给白板。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readSettings } from "./settings";
import type { HostContext } from "./context";
import { packsIn, type PackFiles } from "./stickerpacks";
export { MAX_BITMAP, MAX_SVG } from "./stickerpacks";

const nodeFiles: PackFiles = {
  readdir: async (dir) =>
    (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDir: e.isDirectory(),
    })),
  size: async (p) => (await fs.stat(p)).size,
  text: (p) => fs.readFile(p, "utf8"),
  bytes: (p) => fs.readFile(p),
  toBase64: (b) => Buffer.from(b).toString("base64"),
  join: path.join,
};

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

export const readPacks = (cx: HostContext) => packsIn(stickerDir(cx), nodeFiles, (s) => cx.log("warn", s));
