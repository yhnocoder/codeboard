// 清掉 assets/ 里没人用的图（Note 里粘贴的截图、Image 卡、Web 卡的预览图）。删图的那一刻不删文件：撤销要能拿回来，
// 同一个文件（按内容取名）也可能被别的卡、别的白板用着。改成标记—清除：存储目录打开后空闲时在后台走一遍，
// 存储目录里所有的 .json（白板、组里的白板、卡库 cards/、回收站 .trash/ 里能恢复的，别的也算上）和内存里开着的白板（还没写盘的改动）
// 里只要有这个文件名就算用着（Note 的 Markdown 写 assets/<名>，Image 卡、Web 卡写 <名>：直接找文件名，不管它在哪个字段，Variant、
// Sidenote、问题都算上）。没人用、而且 7 天没改过的才删。每个存储目录一天最多一次（记在这个工作区的状态里）
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Storage } from "./storage";
import { log } from "./log";
import { workspace } from "./ws";

/** 没人用的图至少放这么久才删 */
export const ASSET_MAX_AGE = 7 * 24 * 3600 * 1000;
/** 同一个存储目录两次清理之间至少隔这么久 */
export const SWEEP_EVERY = 24 * 3600 * 1000;
const LAST_RUN = "codeboard.assetSweep";

/** 存储目录下所有的 .json（assets/ 除外）的内容；有一个读不了就抛错（这次不删，免得把它用着的图删了） */
async function jsonTexts(dir: string, assets: string, out: string[] = []): Promise<string[]> {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== assets) await jsonTexts(p, assets, out); }
    else if (e.isFile() && e.name.endsWith(".json")) out.push(await fs.readFile(p, "utf8"));
  }
  return out;
}

/** 走一遍，返回删掉的文件名。force = 不管一天一次 */
export async function sweepAssets(store: Storage, o: { now?: number; force?: boolean } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const dir = store.dir(), assets = store.assetsDir();
  const last = workspace().storage.get<Record<string, number>>(LAST_RUN) ?? {};
  if (!o.force && last[dir] !== undefined && now - last[dir] < SWEEP_EVERY) return [];
  await workspace().storage.set(LAST_RUN, { ...last, [dir]: now });
  const files = (await fs.readdir(assets, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
  if (!files.length) return [];
  const text = [...await jsonTexts(dir, assets), ...store.peekAll().map((b) => JSON.stringify(b))].join("\n");
  const gone: string[] = [];
  for (const f of files) {
    if (text.includes(f)) continue;
    const p = path.join(assets, f);
    try {
      if (now - (await fs.stat(p)).mtimeMs < ASSET_MAX_AGE) continue;
      await fs.rm(p);
      gone.push(f);
    } catch (e) { log("warn", `assets: could not remove ${p}: ${(e as Error).message}`); }
  }
  if (gone.length) log("info", `assets: removed ${gone.length} unused image${gone.length > 1 ? "s" : ""} from ${assets}: ${gone.join(", ")}`);
  return gone;
}

/** 存储目录打开后（启动、换了目录）过一会儿、在后台清一次；返回取消 */
export function scheduleAssetSweep(store: Storage, delay = 60_000): () => void {
  const t = setTimeout(() => { sweepAssets(store).catch((e) => log("warn", `assets: sweep failed: ${(e as Error).message}`)); }, delay);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
}
