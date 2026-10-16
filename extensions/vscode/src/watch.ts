// 什么时候重查新版本：git HEAD 变了（.git/HEAD、refs 的文件监听 + VS Code 自带 git 插件的事件）、保存文件。
// 关着的白板也算一下有几张卡有新版本（侧栏圆点、状态栏）。
import * as vscode from "vscode";
import * as path from "node:path";
import { forgetHeads, gitDirOf, headOf, repoRootOf } from "./git";
import type { Panels } from "./panel";
import { absOf } from "./source";
import type { Storage } from "./storage";
import { boardSegments, countStale, staleFor } from "./versions";
import { debounce, wsFolders } from "./ws";

export function watchVersions(ctx: vscode.ExtensionContext, panels: Panels, store: Storage) {
  const watched = new Set<string>();
  const lastHead = new Map<string, string | null>();

  /** 所有用到的仓库：工作区的根 + 白板上的段 */
  const roots = async () => {
    const out = new Set<string>();
    for (const f of wsFolders()) { const r = await repoRootOf(path.join(f.uri.fsPath, "x")); if (r) out.add(r); }
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
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(gd), "{HEAD,packed-refs,refs/heads/**}"));
    w.onDidChange(onGit); w.onDidCreate(onGit); w.onDidDelete(onGit);
    ctx.subscriptions.push(w);
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
    await panels.refreshStale();
    await countClosed();
  }, 600);

  // VS Code 自带的 git 插件（有的话）：checkout、commit、pull 都会触发
  const gitExt = vscode.extensions.getExtension("vscode.git");
  const hookGit = async () => {
    try {
      const api = (gitExt?.isActive ? gitExt.exports : await gitExt?.activate())?.getAPI?.(1);
      if (!api) return;
      const hook = (repo: { state: { onDidChange: vscode.Event<void> } }) => ctx.subscriptions.push(repo.state.onDidChange(() => onGit()));
      api.repositories.forEach(hook);
      ctx.subscriptions.push(api.onDidOpenRepository(hook));
    } catch { /* 没有 git 插件 */ }
  };
  void hookGit();

  const start = async () => {
    for (const r of await roots()) await watchRoot(r);
    await countClosed();
  };
  void start();

  // 保存文件：只影响 uncommitted 和仓库外文件，重算开着的白板
  const onSave = debounce(() => void panels.refreshStale(), 500);
  ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => onSave()));
  // 白板上加了新仓库的代码：也监听它
  ctx.subscriptions.push(store.onDidSave(() => void (async () => { for (const r of await roots()) await watchRoot(r); })()));
}
