// 插件入口（VS Code 适配层）：接上 Workspace，再注册存储、白板面板、命令、侧栏、编辑器标记、版本监听。
import * as vscode from "vscode";
import * as path from "node:path";
import { affectsSettings, readSettings } from "@codeboard/host/settings";
import { startAnalysis } from "@codeboard/host/analysis";
import { registerCommands } from "./commands";
import { showFile } from "@codeboard/host/git";
import { makeHandler } from "@codeboard/host/handlers";
import { EditorMarks } from "./lens";
import { BoardWebviews, VIEW_TYPE } from "./panel";
import { BoardHub } from "@codeboard/host/hub";
import { watchNameIndex } from "@codeboard/host/nameindex";
import { BoardsTree, GithubTree, QuestionsTree } from "./sidebar";
import { questionsMarkdown } from "@codeboard/core";
import { openOnBoard } from "@codeboard/host/handlers";
import { setMediaDir } from "@codeboard/host/exports";
import { initSource } from "@codeboard/host/source";
import { onDidOpenGithubFile } from "@codeboard/host/github";
import { githubDir, openStorage, type Storage } from "@codeboard/host/storage";
import { scheduleAssetSweep } from "@codeboard/host/assetsweep";
import { watchVersions } from "@codeboard/host/watch";
import { debounce, useWorkspace } from "@codeboard/host/ws";
import { forgetDefs } from "@codeboard/host/defcache";
import { registerVersionDocs, vscodeWorkspace } from "./vscode/workspace";
import { disposeScratch } from "./vscode/scratch";

/** 退出时要把没写盘的白板改动写完 */
let storage: Storage | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const sub = (d: vscode.Disposable) => ctx.subscriptions.push(d);
  const ws = vscodeWorkspace(ctx);
  useWorkspace(ws);
  // tree-sitter 的 wasm 由 esbuild 脚本拷进 dist/
  const ready = startAnalysis(path.join(ctx.extensionUri.fsPath, "dist"));
  const store = (storage = openStorage());
  sub({ dispose: () => store.dispose() });
  // assets/ 里没人用的旧图：存储目录打开后在后台清（一天一次）；换了目录再排一次
  let unsweep = scheduleAssetSweep(store);
  sub({ dispose: () => unsweep() });
  initSource(githubDir());
  const webviews = new BoardWebviews(ctx, store);
  const panels = new BoardHub(webviews.env(), store);
  sub(panels);
  panels.handler = makeHandler(panels);

  // 先注册恢复面板，再等 tree-sitter（恢复时的 ready 消息会等 init 里的分析）
  sub(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { deserializeWebviewPanel: async (p, state) => { await ready; await webviews.restore(panels, p, state); } }));
  registerCommands(ctx, panels, store);

  const tree = new BoardsTree(store, panels);
  const gh = new GithubTree(store);
  sub(vscode.window.registerTreeDataProvider("codeboard.boards", tree));
  sub(vscode.window.registerTreeDataProvider("codeboard.github", gh));
  // QUESTIONS：白板一存盘就重算（防抖）
  setMediaDir(path.join(ctx.extensionUri.fsPath, "media", "board"));
  const qtree = new QuestionsTree(store);
  sub(vscode.window.registerTreeDataProvider("codeboard.questions", qtree));
  sub(store.onDidSave(() => qtree.refresh()));
  sub(store.onDidChange(() => qtree.refresh()));
  sub(vscode.commands.registerCommand("codeboard.questions.showAll", () => qtree.setAll(true)));
  sub(vscode.commands.registerCommand("codeboard.questions.showOpen", () => qtree.setAll(false)));
  sub(vscode.commands.registerCommand("codeboard.copyQuestions", async () => {
    const qs = await qtree.shown();
    if (!qs.length) return void vscode.window.showInformationMessage("No questions to copy.");
    await vscode.env.clipboard.writeText(questionsMarkdown(qs));
    void vscode.window.showInformationMessage(`Copied ${qs.length} question${qs.length > 1 ? "s" : ""} as a Markdown list.`);
  }));
  sub(vscode.commands.registerCommand("codeboard.openQuestion", (board: string, card?: string, line?: number, sticker?: string) => openOnBoard(panels, board, card, line, sticker)));

  const marks = new EditorMarks(ctx, store, panels);
  sub(vscode.languages.registerCodeLensProvider([{ scheme: "file", language: "python" }, { scheme: "file", language: "cpp" }, { scheme: "file", language: "cuda-cpp" }, { scheme: "file", language: "c" }], marks));

  // 历史版本的只读文档
  sub(registerVersionDocs(showFile));

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

  const files = ws.files;
  sub(store.onDidChange(() => { tree.refresh(); void panels.pushBoards(); updateStatus(); }));
  sub(store.onDidSave(() => marks.rebuild()));
  sub(panels.onDidChangeTarget(() => { tree.refresh(); updateStatus(); marks.rebuild(); }));
  sub(panels.onDidChangeStale(() => { tree.refresh(); updateStatus(); void panels.pushBoards(); }));
  sub(vscode.window.onDidChangeVisibleTextEditors(() => marks.redecorate()));
  // 文件改了：缓存的「转到定义」结果作废
  sub(files.onDidEdit((abs) => { marks.redecorate(); if (abs) forgetDefs(); }));
  sub(files.onDidSave((abs) => { if (abs) forgetDefs(); }));
  sub(files.onDidCreate(() => forgetDefs()));
  sub(files.onDidDelete(() => forgetDefs()));
  sub(files.onDidRename(() => forgetDefs()));
  // 名字索引跟着文件的保存、新建、删除、外面的改动增量更新
  sub(watchNameIndex());
  sub(ws.settings.onDidChange((e) => {
    if (e.affects("codeboard.storageDir")) void store.reset().then(() => { marks.rebuild(); unsweep(); unsweep = scheduleAssetSweep(store); });
    if (affectsSettings(e)) panels.broadcast({ type: "host", host: { settings: readSettings() } });
    if (e.affects("editor.fontFamily")) panels.broadcast({ type: "host", host: { fontFamily: ws.settings.get<string>("editor.fontFamily") } });
  }));
  // GITHUB FILES：白板里加了 GitHub 卡，或这个工作区打开了新的 GitHub 文件
  sub(store.onDidSave(() => gh.refresh()));
  sub(onDidOpenGithubFile(() => gh.refresh()));

  await ready;
  sub(watchVersions(panels, store));
  marks.rebuild();
  updateStatus();
}

export async function deactivate() { disposeScratch(); await storage?.flush(); }
