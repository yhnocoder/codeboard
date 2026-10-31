import * as vscode from "vscode";
import * as path from "node:path";
import { debounce, showFile, startHost, type Host } from "@codeboard/host";
import { questionsMarkdown } from "@codeboard/core";
import { analyzedEditorLangs } from "@codeboard/analysis/langs";
import { registerCommands } from "./commands";
import { EditorMarks } from "./lens";
import { BoardWebviews, VIEW_TYPE } from "./panel";
import { BoardsTree, GithubTree, QuestionsTree } from "./sidebar";
import { registerVersionDocs, vscodeWorkspace } from "./vscode/workspace";
import { disposeScratch } from "./vscode/scratch";

/** 退出时要把没写盘的白板改动写完 */
let host: Host | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const sub = (d: vscode.Disposable) => ctx.subscriptions.push(d);
  const ws = vscodeWorkspace(ctx);
  const webviews = new BoardWebviews(ctx, () => h.store.assetsDir());
  // tree-sitter 的 wasm 由 esbuild 脚本拷进 dist/
  const h = (host = startHost(ws, webviews.env(), {
    wasmDir: path.join(ctx.extensionUri.fsPath, "dist"),
    mediaDir: path.join(ctx.extensionUri.fsPath, "media", "board"),
  }));
  sub(h);
  const { hub, store } = h;

  // 先注册恢复面板，再等 tree-sitter（恢复时的 ready 消息会等 init 里的分析）
  sub(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { deserializeWebviewPanel: async (p, state) => { await h.ready; await webviews.restore(hub, p, state); } }));
  registerCommands(ctx, h);

  const tree = new BoardsTree(store, hub);
  const gh = new GithubTree(store);
  sub(vscode.window.createTreeView("codeboard.boards", { treeDataProvider: tree, dragAndDropController: tree }));
  sub(vscode.window.registerTreeDataProvider("codeboard.github", gh));
  const qtree = new QuestionsTree(store);
  sub(vscode.window.registerTreeDataProvider("codeboard.questions", qtree));
  sub(vscode.commands.registerCommand("codeboard.questions.showAll", () => qtree.setAll(true)));
  sub(vscode.commands.registerCommand("codeboard.questions.showOpen", () => qtree.setAll(false)));
  sub(vscode.commands.registerCommand("codeboard.copyQuestions", async () => {
    const qs = await qtree.shown();
    if (!qs.length) return void vscode.window.showInformationMessage("No questions to copy.");
    await vscode.env.clipboard.writeText(questionsMarkdown(qs));
    void vscode.window.showInformationMessage(`Copied ${qs.length} question${qs.length > 1 ? "s" : ""} as a Markdown list.`);
  }));

  const marks = new EditorMarks(ctx, store, hub);
  sub(vscode.languages.registerCodeLensProvider(analyzedEditorLangs().map((language) => ({ scheme: "file", language })), marks));

  sub(registerVersionDocs(showFile));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "codeboard.switchTarget";
  sub(status);
  const updateStatus = debounce(async () => {
    const metas = await store.list();
    const t = metas.find((m) => m.id === hub.target);
    if (!t) { status.hide(); return; }
    status.text = `$(layout) ${t.name}${t.stale ? `  $(circle-filled) ${t.stale}` : ""}`;
    status.tooltip = `CodeBoard: Add to Board goes to “${t.name}”${t.stale ? ` · ${t.stale} cards have new versions` : ""}. Click to switch.`;
    status.show();
  }, 100);

  sub(store.onDidChange(() => { tree.refresh(); qtree.refresh(); updateStatus(); }));
  sub(store.onDidSave(() => { marks.rebuild(); qtree.refresh(); gh.refresh(); }));
  sub(hub.onDidChangeTarget(() => { tree.refresh(); updateStatus(); marks.rebuild(); }));
  sub(hub.onDidChangeStale(() => { tree.refresh(); updateStatus(); }));
  sub(h.onDidSwitchStorage(() => marks.rebuild()));
  sub(h.onDidOpenGithubFile(() => gh.refresh()));
  sub(vscode.window.onDidChangeVisibleTextEditors(() => marks.redecorate()));
  sub(ws.files.onDidEdit(() => marks.redecorate()));

  await h.ready;
  marks.rebuild();
  updateStatus();
}

export async function deactivate() { disposeScratch(); await host?.flush(); }
