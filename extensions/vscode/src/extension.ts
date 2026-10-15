import * as vscode from "vscode";
import { symbolAt, type Sym } from "@codeboard/core";
import { Storage } from "./storage";
import { BoardPanel } from "./board";
import { BoardsTree } from "./tree";
import { EditorMarks } from "./editor";
import { invalidateIndex, relPath, symbolIndex, symbolsOf } from "./code";

export function activate(ctx: vscode.ExtensionContext) {
  const store = new Storage(ctx);
  const panel = new BoardPanel(ctx, store);
  const tree = new BoardsTree(store, panel);
  const marks = new EditorMarks(panel);
  const sub = (d: vscode.Disposable) => ctx.subscriptions.push(d);

  sub(vscode.window.registerTreeDataProvider("codeboard.boards", tree));
  sub(vscode.languages.registerCodeLensProvider([{ scheme: "file" }], marks));
  sub(vscode.window.registerWebviewPanelSerializer(BoardPanel.viewType, { deserializeWebviewPanel: (p) => panel.restore(p) }));
  sub(store.onDidChange(() => tree.refresh()));
  let lastBoard: string | undefined;
  sub(panel.onDidChangeBoard((b) => {
    marks.update();
    if (b?.id !== lastBoard) { lastBoard = b?.id; tree.refresh(); }
  }));

  const boardId = (arg: unknown): string | undefined =>
    typeof arg === "string" ? arg : (arg as { meta?: { id: string } } | undefined)?.meta?.id;

  const cmd = (id: string, fn: (...a: any[]) => unknown) => sub(vscode.commands.registerCommand(id, fn));

  cmd("codeboard.openBoard", (arg?: unknown) => panel.open(boardId(arg)));

  cmd("codeboard.newBoard", async () => {
    const name = await vscode.window.showInputBox({ prompt: "新白板的名字", value: "新白板", placeHolder: "比如：一次 generate 的完整流程" });
    if (!name?.trim()) return;
    const b = await store.create(name.trim());
    await panel.open(b.id);
  });

  cmd("codeboard.renameBoard", async (arg?: unknown) => {
    const id = boardId(arg) ?? panel.board?.id;
    const b = id && (panel.board?.id === id ? panel.board : await store.load(id));
    if (!b) return;
    const name = await vscode.window.showInputBox({ prompt: "重命名白板", value: b.name });
    if (!name?.trim() || name.trim() === b.name) return;
    const nb = { ...b, name: name.trim() };
    await store.save(nb);
    if (panel.board?.id === id) await panel.load(nb);
  });

  cmd("codeboard.deleteBoard", async (arg?: unknown) => {
    const id = boardId(arg);
    const b = id && (await store.load(id));
    if (!b) return;
    const ok = await vscode.window.showWarningMessage(`删除白板「${b.name}」？`, { modal: true, detail: "白板上的卡片和箭头都会删掉，代码不受影响。" }, "删除");
    if (ok !== "删除") return;
    await store.remove(b.id);
    if (panel.board?.id === b.id) {
      const rest = await store.list();
      if (rest[0]) await panel.open(rest[0].id);
      else await panel.open((await store.create("第一张白板")).id);
    }
  });

  cmd("codeboard.addSelection", async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const s = ed.selection;
    const start = s.start.line + 1;
    // 选区停在下一行行首时不算那一行
    const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
    await panel.addCard(relPath(ed.document.uri.fsPath), start, end);
  });

  cmd("codeboard.addSymbol", async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    if (!ed.selection.isEmpty) return vscode.commands.executeCommand("codeboard.addSelection");
    const rel = relPath(ed.document.uri.fsPath);
    const lines = ed.document.getText().split(/\r?\n/);
    const sym = symbolAt(await symbolsOf(rel, lines, ed.document.languageId), ed.selection.active.line + 1);
    if (!sym) return void vscode.window.showInformationMessage("光标不在函数或类里。可以先选中几行，再右键「添加到 CodeBoard」。");
    await panel.addCard(rel, sym.start, sym.end, sym);
  });

  cmd("codeboard.pickSymbol", async () => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { e?: { path: string; sym: Sym } }>();
    qp.placeholder = "搜一个函数或类，放到白板上";
    qp.busy = true;
    qp.matchOnDescription = true;
    qp.show();
    const idx = await symbolIndex();
    qp.items = [...idx.values()].flat()
      .sort((a, b) => a.sym.qual.localeCompare(b.sym.qual))
      .map((e) => ({ label: `$(${e.sym.kind === "class" ? "symbol-class" : "symbol-method"}) ${e.sym.qual}`, description: `${e.path}:${e.sym.start}`, e }));
    qp.busy = false;
    qp.onDidAccept(async () => {
      const e = qp.selectedItems[0]?.e;
      qp.hide();
      if (e) await panel.addCard(e.path, e.sym.start, e.sym.end, e.sym);
    });
    qp.onDidHide(() => qp.dispose());
  });

  cmd("codeboard.focusCard", async (board?: string, card?: string) => {
    if (!card) return;
    if (panel.board?.id !== board || !panel.visible) await panel.open(board, { preserveFocus: false });
    panel.focus(card);
  });

  // 代码一改就重算同步状态：只挪了位置的静默跟上，内容变了的亮黄点
  let timer: NodeJS.Timeout | undefined;
  const dirty = new Set<string>();
  sub(vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== "file" || !e.contentChanges.length) return;
    dirty.add(relPath(e.document.uri.fsPath));
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const paths = new Set(dirty);
      dirty.clear();
      await panel.refresh(paths);
      marks.update();
    }, 400);
  }));
  sub(vscode.workspace.onDidSaveTextDocument(() => invalidateIndex()));
  sub(vscode.workspace.onDidCreateFiles(() => invalidateIndex()));
  sub(vscode.workspace.onDidDeleteFiles(() => invalidateIndex()));
  sub(vscode.window.onDidChangeVisibleTextEditors(() => marks.update()));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("codeboard.storageDir")) tree.refresh(); }));
}

export function deactivate() {}
