import { boardSegments, variantSegments } from "@codeboard/core";
// 什么时候重查新版本：git HEAD 变了（.git/HEAD、refs 的文件监听 + VS Code 自带 git 插件的事件）、保存文件、
// 编辑器里改了白板上用到的文件（版本状态按编辑器里的内容算，没保存的改动、Revert File 也算）。文件的改动只重查这个文件里的段，
// 只在有它的白板上（打字时每停一下都会触发：不重读、不重新分析别的文件）。
import * as fs from "node:fs";
import * as path from "node:path";
import type { Disposable } from "@codeboard/core";
import { forgetIgnored, forgetRepos, gitDirOf, headOf, repoRootOf } from "./git";
import type { BoardHost } from "./boards";
import { absOf, hasLocalFile } from "./source";
import type { Storage } from "./storage";
import { countStale, staleFor, staleSegments } from "./versions";
import { debounce, inWorkspace, workspace, wsRoots } from "./ws";
import { forgetDefs } from "./defcache";
import { log } from "./log";

/** 攒多久的 git 事件再查 HEAD、攒多久的文件改动再重查（ms） */
const GIT_PAUSE = 600;
export const RECHECK_PAUSE = 500;

/** ready：开始时的监听都挂好、关着的白板数过一遍之后（测试等它，不靠等一段时间） */
export function watchVersions(panels: BoardHost, store: Storage): Disposable & { ready: Promise<void> } {
  const files = workspace().files;
  const subs: Disposable[] = [];
  const watched = new Set<string>();
  const lastHead = new Map<string, string | null>();

  const roots = async () => {
    const out = new Set<string>();
    for (const f of wsRoots()) { const r = await repoRootOf(path.join(f, "x")); if (r) out.add(r); }
    for (const { board } of await store.all()) for (const s of boardSegments(board)) {
      if (s.version.kind !== "git" || !hasLocalFile(s.src)) continue;
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
    subs.push(files.watch(gd, "{HEAD,config,packed-refs,refs/heads/**,refs/remotes/origin/HEAD}", () => onGit()));
    // 忽略规则变了（保存、在 VS Code 外面改、checkout 都算）：check-ignore 记下的回答作废。
    // 工作区里的仓库整棵树都看（VS Code 本来就在监听它），别的仓库只看根上的 .gitignore（不为它起递归的监听）
    subs.push(files.watch(path.join(gd, "info"), "exclude", () => forgetIgnored()));
    subs.push(files.watch(root, inWorkspace(root) ? "**/.gitignore" : ".gitignore", () => forgetIgnored()));
  };

  /**
   * 关着的白板：算有几张卡有新版本。读不到的段 staleFor 自己当没变；这里出错是 bug（白板的结构、侧栏），
   * 记进日志（Copy Diagnostics 也看得到），接着算别的白板
   */
  const countClosed = async () => {
    for (const { board } of await store.all()) {
      if (panels.get(board.id)?.ready) continue;
      try { const ss = staleSegments(board); panels.staleChanged(board.id, countStale(board, await staleFor(ss.segs, ss.up))); }
      catch (e) { log("warn", `versions: could not count new versions on closed board ${board.id}: ${e instanceof Error ? e.message : e}`); }
    }
  };

  const onGit = debounce(async () => {
    forgetRepos();
    let changed = false;
    for (const r of watched) {
      const h = await headOf(r);
      if (lastHead.get(r) !== h) { changed = true; lastHead.set(r, h); }
    }
    if (!changed) return;
    forgetDefs(); // checkout 之类：文件可能整批换了
    forgetIgnored();
    await panels.refreshStale();
    await countClosed();
  }, GIT_PAUSE);

  subs.push(files.onDidChangeGit(() => onGit()));

  const start = async () => {
    for (const r of await roots()) await watchRoot(r);
    await countClosed();
  };
  const started = start();

  // 保存、改了文件：只影响这个文件里的段（uncommitted、仓库外文件），攒一会儿一起重查
  const changed = new Set<string>();
  const flush = debounce(() => { const paths = new Set(changed); changed.clear(); void panels.refreshStale(paths); }, RECHECK_PAUSE);
  const recheck = (abs: string) => { changed.add(abs); flush(); };
  subs.push(files.onDidSave((abs) => { if (abs) recheck(abs); }));
  // 在 VS Code 外面改了卡片用到的文件（git checkout -- f、别的编辑器）：也重算。每个文件一个监听。
  // Variant 的文件也算（另一个 worktree、复制出来的文件：在别处保存后卡上跟着刷新）
  const watchedFiles = new Set<string>();
  /**
   * fs.watch, not the editor's watcher: VS Code starts a watch only once the ones asked for before it have started, and a change made
   * meanwhile fires nothing (on CI the Python Environments extension's recursive watch on /usr/lib took 18 s, and the e2e edit of a
   * Variant's file in that time was lost). fs.watch is in place when it returns, so the catch-up re-check covers everything before.
   * It watches the folder, so a save that renames a new file over the old one counts too. false = the folder is not there (yet): the
   * next board save tries again
   */
  const watchFile = (a: string) => {
    const name = path.basename(a);
    let w: fs.FSWatcher;
    try { w = fs.watch(path.dirname(a), { persistent: false }, (_e, f) => { if (!f || f === name) recheck(a); }); }
    catch { return false; }
    // the folder went away: the file with it
    w.on("error", () => { w.close(); watchedFiles.delete(a); recheck(a); });
    subs.push({ dispose: () => w.close() });
    return true;
  };
  const watchFiles = async (catchUp: boolean) => {
    for (const { board } of await store.all()) for (const s of [...boardSegments(board), ...variantSegments(board)]) {
      if (!hasLocalFile(s.src)) continue;
      const a = absOf(s);
      if (!a || watchedFiles.has(a) || !watchFile(a)) continue;
      watchedFiles.add(a);
      // The file was read when its card or Variant was added, before this watch existed: a change made in between fires no event
      if (catchUp) recheck(a);
    }
  };
  const filesWatched = watchFiles(false);
  subs.push(files.onDidEdit((abs) => { if (abs && watchedFiles.has(abs)) recheck(abs); }));
  subs.push(store.onDidSave(() => void (async () => { for (const r of await roots()) await watchRoot(r); await watchFiles(true); })()));
  return { dispose: () => { for (const d of subs) d.dispose(); }, ready: Promise.all([started, filesWatched]).then(() => undefined) };
}
