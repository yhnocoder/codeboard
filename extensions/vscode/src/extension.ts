// 插件入口：存储、白板面板、命令、侧栏、编辑器标记、版本监听。
import * as vscode from "vscode";
import { affectsSettings, readSettings } from "./settings";
import * as path from "node:path";
import { startAnalysis } from "./analysis";
import { GIT_SCHEME, parseGitUri } from "./cards";
import { registerCommands } from "./commands";
import { showFile } from "./git";
import { makeHandler } from "./handlers";
import { EditorMarks } from "./lens";
import { Panels } from "./panel";
import { reindexFile, resetIndex } from "./resolve";
import { BoardsTree, GithubTree } from "./sidebar";
import { initSource } from "./source";
import { Storage } from "./storage";
import { watchVersions } from "./watch";
import { debounce } from "./ws";
import { forgetDefs } from "./defcache";

export async function activate(ctx: vscode.ExtensionContext) {
  const sub = (d: vscode.Disposable) => ctx.subscriptions.push(d);
  // tree-sitter 的 wasm 由 esbuild 脚本拷进 dist/
  const ready = startAnalysis(path.join(ctx.extensionUri.fsPath, "dist"));
  const store = new Storage(ctx);
  initSource(ctx, store.githubDir());
  const panels = new Panels(ctx, store);
  panels.handler = makeHandler(panels);

  // 先注册恢复面板，再等 tree-sitter（恢复时的 ready 消息会等 init 里的分析）
  sub(vscode.window.registerWebviewPanelSerializer(Panels.viewType, { deserializeWebviewPanel: async (p, state) => { await ready; await panels.restore(p, state); } }));
  registerCommands(ctx, panels, store);

  const tree = new BoardsTree(store, panels);
  const gh = new GithubTree(store);
  sub(vscode.window.registerTreeDataProvider("codeboard.boards", tree));
  sub(vscode.window.registerTreeDataProvider("codeboard.github", gh));

  const marks = new EditorMarks(ctx, store, panels);
  sub(vscode.languages.registerCodeLensProvider([{ scheme: "file", language: "python" }, { scheme: "file", language: "cpp" }, { scheme: "file", language: "cuda-cpp" }, { scheme: "file", language: "c" }], marks));

  // 历史版本的只读文档
  sub(vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
    provideTextDocumentContent: async (u) => {
      const q = parseGitUri(u);
      return q ? ((await showFile(q.root, q.commit, q.path)) ?? "") : "";
    },
  }));

  // 状态栏：目标白板 + 有新版本的卡片数
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "codeboard.switchTarget";
  sub(status);
  const updateStatus = debounce(async () => {
    const metas = await store.list();
    const t = metas.find((m) => m.id === panels.target);
    if (!t) { status.hide(); return; }
    status.text = `$(layout) ${t.name}${t.stale ? `  $(circle-filled) ${t.stale}` : ""}`;
    status.tooltip = `CodeBoard: Add to Board goes to “${t.name}”${t.stale ? ` · ${t.stale} cards have new versions` : ""}. Click to switch.`;
    status.show();
  }, 100);

  sub(store.onDidChange(() => { tree.refresh(); void panels.pushBoards(); updateStatus(); }));
  sub(store.onDidSave(() => marks.rebuild()));
  sub(panels.onDidChangeTarget(() => { tree.refresh(); updateStatus(); marks.rebuild(); }));
  sub(panels.onDidChangeStale(() => { tree.refresh(); updateStatus(); void panels.pushBoards(); }));
  sub(vscode.window.onDidChangeVisibleTextEditors(() => marks.redecorate()));
  // 文件改了：缓存的「转到定义」结果作废
  sub(vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length) { marks.redecorate(); if (e.document.uri.scheme === "file") forgetDefs(); } }));
  sub(vscode.workspace.onDidSaveTextDocument((d) => { if (d.uri.scheme === "file") { forgetDefs(); void reindexFile(d.uri.fsPath); } }));
  sub(vscode.workspace.onDidCreateFiles(() => { forgetDefs(); resetIndex(); }));
  sub(vscode.workspace.onDidDeleteFiles(() => { forgetDefs(); resetIndex(); }));
  sub(vscode.workspace.onDidRenameFiles(() => forgetDefs()));
  sub(vscode.workspace.onDidChangeWorkspaceFolders(() => resetIndex()));
  sub(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("codeboard.storageDir")) { store.reset(); marks.rebuild(); }
    if (affectsSettings(e)) panels.broadcast({ type: "host", host: { settings: readSettings() } });
    if (e.affectsConfiguration("editor.fontFamily")) panels.broadcast({ type: "host", host: { fontFamily: vscode.workspace.getConfiguration("editor").get<string>("fontFamily") } });
  }));
  // GitHub 缓存可能在白板里加了新文件
  sub(store.onDidSave(() => gh.refresh()));

  await ready;
  watchVersions(ctx, panels, store);
  marks.rebuild();
  updateStatus();
}

export function deactivate() {}
