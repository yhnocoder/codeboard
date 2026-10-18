// 白板存储：目录结构、分组、.trash、资源都在 core（@codeboard/core/storage），这里只决定目录在哪、接上 node:fs。
// 默认放在插件给这个工作区的存储目录里（boards/），不往正在读的仓库里写；codeboard.storageDir 可以换位置。
import * as path from "node:path";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "./nodefs";
import { log } from "./log";
import { settingDir, workspace } from "./ws";

export type { Storage };

export const openStorage = () => new Storage(nodeFs, { dir: boardDir, log });

function boardDir(): string {
  const set = workspace().settings.get<string>("codeboard.storageDir")?.trim();
  return set ? settingDir(set) : path.join(workspace().storage.dir(), "boards");
}

/** GitHub 文件缓存：按 commit 存，不会变，所有工作区共用 */
export const githubDir = () => path.join(workspace().storage.globalDir(), "github");
