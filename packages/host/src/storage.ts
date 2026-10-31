// 默认放在插件给这个工作区的存储目录里（boards/），不往正在读的仓库里写。第一个工作区文件夹下有 .codeboard/ 就用它
// （白板跟着仓库走，git 管得了，克隆了仓库的同事直接看到）；codeboard.storageDir 设了的话它说了算。
import * as path from "node:path";
import { mkdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { Emitter, type Camera, type Disposable } from "@codeboard/core";
import { RESERVED, Storage } from "@codeboard/core/storage";
import { nodeFs } from "./nodefs";
import { log } from "./log";
import { debounce, settingDir, workspace, ws0 } from "./ws";

export type { Storage };

/** 项目里的白板目录（第一个工作区文件夹下） */
export const PROJECT_DIR = ".codeboard";
export const projectDir = (): string | undefined => (ws0() ? path.join(ws0(), PROJECT_DIR) : undefined);

/** 每个 Storage 现在用的目录：只在 followStorageDir 里换 */
const dirs = new WeakMap<Storage, { dir: string }>();
const switched = new Emitter<Storage>();
/** 存储目录换了（followStorageDir）：行号旁标记、资源清理、跨项目登记表跟着换 */
export const onDidSwitchStorage = switched.event;

/**
 * 目录先建好再看：VS Code 的 watcher 看一个还不存在的目录时，目录和文件一起出现（别的窗口 Copy to Another Project… 到一个
 * 还没有白板的项目）那个文件会漏掉，要重新加载窗口才列出来
 */
export function openStorage(): Storage {
  const at = { dir: boardDir() };
  const store = new Storage(nodeFs, {
    dir: () => at.dir,
    log,
    cams,
    watch: (base, glob, fn) => {
      try {
        mkdirSync(base, { recursive: true });
      } catch (e) {
        log("warn", `storage: cannot create ${base}: ${e instanceof Error ? e.message : e}`);
      }
      return workspace().files.watch(base, glob, fn);
    },
  });
  dirs.set(store, at);
  return store;
}

function boardDir(): string {
  const set = workspace().settings.get<string>("codeboard.storageDir")?.trim();
  if (set) return settingDir(set);
  const p = projectDir();
  return p && isDir(p) ? p : path.join(workspace().storage.dir(), "boards");
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 该用的目录变了（设置改了、.codeboard/ 出现或没了：git checkout、Move Boards into Project）就换过去：
 * 没写的改动写回它们原来的文件（reset），开着的白板之后读写新目录里同 id 的白板。换了返回 true
 */
export async function followStorageDir(store: Storage): Promise<boolean> {
  const at = dirs.get(store),
    dir = boardDir();
  if (!at || at.dir === dir) return false;
  at.dir = dir;
  await store.reset();
  log("info", `storage: boards are now in ${dir}`);
  switched.fire(store);
  return true;
}

/** 看着第一个工作区文件夹下的 .codeboard/ 有没有（它自己和它下面一层：git 建 / 删文件夹时不一定单独报文件夹） */
export function watchProjectDir(fn: () => void): Disposable {
  const root = ws0();
  if (!root) return { dispose() {} };
  const later = debounce(fn, 300);
  return workspace().files.watch(root, `{${PROJECT_DIR},${PROJECT_DIR}/*}`, later);
}

/** Move Boards into Project 的结果：moved = 搬好了（to = .codeboard/ 的路径）；否则 why = 为什么没搬（给用户看） */
export type IntoProject = { moved: true; to: string } | { moved: false; why: string };

/** 不进 git 的：删掉的白板、写到一半的临时文件 */
const GITIGNORE = ".trash/\n*.tmp\n";

/**
 * 把现在存储目录里的东西（白板和组、卡库 cards/、assets/、runs/、.trash/）整个搬进第一个工作区文件夹下的 .codeboard/，
 * 写一个 .gitignore（.trash/ 不进 git），再换过去（followStorageDir）。先拷再删原来的：拷到一半失败时原来的还在。
 * .codeboard/ 里已经有白板就不搬（不悄悄合并两份）
 */
export async function moveIntoProject(store: Storage): Promise<IntoProject> {
  const to = projectDir();
  if (!to)
    return {
      moved: false,
      why: "Open a folder first: boards move into a .codeboard folder in the first workspace folder.",
    };
  if (workspace().settings.get<string>("codeboard.storageDir")?.trim())
    return {
      moved: false,
      why: "The setting codeboard.storageDir chooses where boards are stored. Clear it first to keep boards in the project.",
    };
  const from = store.dir();
  if (path.resolve(from) === path.resolve(to))
    return { moved: false, why: `Boards are already stored in the project (${PROJECT_DIR}).` };
  if (await hasBoards(to))
    return {
      moved: false,
      why: `${PROJECT_DIR} in ${path.basename(ws0())} already has boards. Move or delete them first: boards are not merged.`,
    };
  await store.flush();
  await fs.mkdir(to, { recursive: true });
  for (const d of await fs.readdir(from, { withFileTypes: true }).catch(() => [])) {
    if (d.name.endsWith(".tmp")) continue;
    await fs.cp(path.join(from, d.name), path.join(to, d.name), { recursive: true, force: false, errorOnExist: false });
  }
  await fs.writeFile(path.join(to, ".gitignore"), GITIGNORE, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  await followStorageDir(store);
  await fs.rm(from, { recursive: true, force: true });
  return { moved: true, to };
}

/** 目录里（顶层或一层组文件夹里）有没有白板文件 */
async function hasBoards(dir: string): Promise<boolean> {
  for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (d.isFile() && d.name.endsWith(".json")) return true;
    if (
      d.isDirectory() &&
      !RESERVED.has(d.name) &&
      !d.name.startsWith(".") &&
      (await fs.readdir(path.join(dir, d.name)).catch(() => [])).some((n) => n.endsWith(".json"))
    )
      return true;
  }
  return false;
}

/** 镜头按白板 id 记在这台机器上（工作区状态）：平移、缩放不改白板文件。只留最近的这么多块 */
const CAMS = "codeboard.cams",
  MAX_CAMS = 500;
const cams = {
  get: (id: string) => workspace().storage.get<Record<string, Camera>>(CAMS)?.[id],
  set: (id: string, cam: Camera) => {
    const all = { ...(workspace().storage.get<Record<string, Camera>>(CAMS) ?? {}) };
    delete all[id]; // 重新放到最后：最近动过的在后面
    all[id] = cam;
    const ids = Object.keys(all);
    for (const k of ids.slice(0, Math.max(0, ids.length - MAX_CAMS))) delete all[k];
    void workspace().storage.set(CAMS, all);
  },
};

/** GitHub 文件缓存：按 commit 存，不会变，所有工作区共用 */
export const githubDir = () => path.join(workspace().storage.globalDir(), "github");
