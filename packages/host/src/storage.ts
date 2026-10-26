// 默认放在插件给这个工作区的存储目录里（boards/），不往正在读的仓库里写；codeboard.storageDir 可以换位置。
import * as path from "node:path";
import { mkdirSync } from "node:fs";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "./nodefs";
import { log } from "./log";
import { settingDir, workspace } from "./ws";

export type { Storage };

/**
 * 目录先建好再看：VS Code 的 watcher 看一个还不存在的目录时，目录和文件一起出现（别的窗口 Copy to Another Project… 到一个
 * 还没有白板的项目）那个文件会漏掉，要重新加载窗口才列出来
 */
export const openStorage = () => new Storage(nodeFs, { dir: boardDir, log, watch: (base, glob, fn) => {
  try { mkdirSync(base, { recursive: true }); } catch (e) { log("warn", `storage: cannot create ${base}: ${e instanceof Error ? e.message : e}`); }
  return workspace().files.watch(base, glob, fn);
} });

function boardDir(): string {
  const set = workspace().settings.get<string>("codeboard.storageDir")?.trim();
  return set ? settingDir(set) : path.join(workspace().storage.dir(), "boards");
}

/** GitHub 文件缓存：按 commit 存，不会变，所有工作区共用 */
export const githubDir = () => path.join(workspace().storage.globalDir(), "github");
