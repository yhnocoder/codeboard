// 什么时候重查新版本：git HEAD 变了（.git/HEAD、refs 的文件监听 + VS Code 自带 git 插件的事件）、保存文件。
// 关着的白板也算一下有几张卡有新版本（侧栏圆点、状态栏）。
import * as path from "node:path";
import type { Disposable } from "@codeboard/core";
import { forgetHeads, gitDirOf, headOf, repoRootOf } from "./git";
import type { BoardHost } from "./boards";
import { absOf } from "./source";
import type { Storage } from "./storage";
import { boardSegments, countStale, staleFor } from "./versions";
import { debounce, workspace, wsRoots } from "./ws";
import { forgetDefs } from "./defcache";

export function watchVersions(panels: BoardHost, store: Storage): Disposable {
  const files = workspace().files;
  const subs: Disposable[] = [];
  const watched = new Set<string>();
  const lastHead = new Map<string, string | null>();

  /** 所有用到的仓库：工作区的根 + 白板上的段 */
  const roots = async () => {
    const out = new Set<string>();
    for (const f of wsRoots()) { const r = await repoRootOf(path.join(f, "x")); if (r) out.add(r); }
    for (const { board } of await store.all()) for (const s of boardSegments(board)) {
      if (s.version.kind !== "git" || s.src.kind === "free" || s.src.kind === "github") continue;
      const a = absOf(s);
      const r = a && (await repoRootOf(a));
      if (r) out.add(r);
    }
    return [...out];
  };

  const watchRoot = async (root: string) => {
    if (watched.has(root)) return;
    watched.add(root);
    lastHead.set(root, await headOf(root));
    const gd = await gitDirOf(root);
    if (!gd) return;
    subs.push(files.watch(gd, "{HEAD,packed-refs,refs/heads/**}", () => onGit()));
  };

  /** 关着的白板：算有几张卡有新版本 */
  const countClosed = async () => {
    for (const { board } of await store.all()) {
      if (panels.get(board.id)?.ready) continue;
      try { panels.staleChanged(board.id, countStale(board, await staleFor(boardSegments(board)))); } catch { /* */ }
    }
  };

  const onGit = debounce(async () => {
    forgetHeads();
    let changed = false;
    for (const r of watched) {
      const h = await headOf(r);
      if (lastHead.get(r) !== h) { changed = true; lastHead.set(r, h); }
    }
    if (!changed) return;
    forgetDefs(); // checkout 之类：文件可能整批换了
    await panels.refreshStale();
    await countClosed();
  }, 600);

  // 编辑器自带的 git 集成（VS Code 的 git 插件，有的话）：checkout、commit、pull 都会触发
  subs.push(files.onDidChangeGit(() => onGit()));

  const start = async () => {
    for (const r of await roots()) await watchRoot(r);
    await countClosed();
  };
  void start();

  // 保存文件：只影响 uncommitted 和仓库外文件，重算开着的白板
  const onSave = debounce(() => void panels.refreshStale(), 500);
  subs.push(files.onDidSave(() => onSave()));
  // 在 VS Code 外面改了卡片用到的文件（git checkout -- f、别的编辑器）：也重算。每个文件一个监听
  const watchedFiles = new Set<string>();
  const watchFiles = async () => {
    for (const { board } of await store.all()) for (const s of boardSegments(board)) {
      if (s.src.kind === "free" || s.src.kind === "github") continue;
      const a = absOf(s);
      if (!a || watchedFiles.has(a)) continue;
      watchedFiles.add(a);
      subs.push(files.watch(path.dirname(a), path.basename(a), () => onSave()));
    }
  };
  void watchFiles();
  // 白板上加了新仓库 / 新文件的代码：也监听它
  subs.push(store.onDidSave(() => void (async () => { for (const r of await roots()) await watchRoot(r); await watchFiles(); })()));
  return { dispose: () => { for (const d of subs) d.dispose(); } };
}
