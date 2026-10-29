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
import { recordProject } from "@codeboard/host/transfer";
import { onDidOpenGithubFile } from "@codeboard/host/github";
import { followStorageDir, githubDir, onDidSwitchStorage, openStorage, watchProjectDir, type Storage } from "@codeboard/host/storage";
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
  let unsweep = scheduleAssetSweep(store);
  sub({ dispose: () => unsweep() });
  initSource(githubDir());
  const webviews = new BoardWebviews(ctx, store);
  const panels = new BoardHub(webviews.env(), store);
  sub(panels);
  panels.handler = makeHandler(panels);
  // 跨工作区记下这个项目的存储目录：别的窗口的 Copy / Move to Another Project… 在里面找
  void recordProject(panels.globalState, store.dir());

  // 先注册恢复面板，再等 tree-sitter（恢复时的 ready 消息会等 init 里的分析）
  sub(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { deserializeWebviewPanel: async (p, state) => { await ready; await webviews.restore(panels, p, state); } }));
  registerCommands(ctx, panels, store);

  const tree = new BoardsTree(store, panels);
  const gh = new GithubTree(store);
  sub(vscode.window.registerTreeDataProvider("codeboard.boards", tree));
  sub(vscode.window.registerTreeDataProvider("codeboard.github", gh));
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

  sub(registerVersionDocs(showFile));

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
  sub(files.onDidEdit((abs) => { marks.redecorate(); if (abs) forgetDefs(); }));
  sub(files.onDidSave((abs) => { if (abs) forgetDefs(); }));
  sub(files.onDidCreate(() => forgetDefs()));
  sub(files.onDidDelete(() => forgetDefs()));
  sub(files.onDidRename(() => forgetDefs()));
  sub(watchNameIndex());
  sub(ws.settings.onDidChange((e) => {
    if (e.affects("codeboard.storageDir")) void followStorageDir(store);
    if (affectsSettings(e)) panels.broadcast({ type: "host", host: { settings: readSettings() } });
    if (e.affects("editor.fontFamily")) panels.broadcast({ type: "host", host: { fontFamily: ws.settings.get<string>("editor.fontFamily") } });
  }));
  // 存储目录换了（设置、.codeboard/ 出现或没了、Move Boards into Project）
  sub(onDidSwitchStorage(() => { void panels.followStorage(); marks.rebuild(); unsweep(); unsweep = scheduleAssetSweep(store); void recordProject(panels.globalState, store.dir()); }));
  sub(watchProjectDir(() => void followStorageDir(store)));
  sub(files.onDidChangeRoots(() => void followStorageDir(store)));
  sub(store.onDidSave(() => gh.refresh()));
  sub(onDidOpenGithubFile(() => gh.refresh()));

  await ready;
  sub(watchVersions(panels, store));
  marks.rebuild();
  updateStatus();
}

export async function deactivate() { disposeScratch(); await storage?.flush(); }
