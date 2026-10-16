// 编辑器里的标记（VS Code 适配层）：CodeLens 只挂在白板上有的函数 / 类上方（「+ Card」「on N boards」），
// 目标白板上有的行在行号旁画一道细竖条。画什么由 marks.ts 算。
import * as vscode from "vscode";
import { BoardMarks } from "./marks";
import type { Panels } from "./panel";
import type { Storage } from "./storage";
import { debounce } from "./ws";

export class EditorMarks implements vscode.CodeLensProvider {
  private marks = new BoardMarks();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private bar: vscode.TextEditorDecorationType;

  constructor(ctx: vscode.ExtensionContext, private store: Storage, private panels: Panels) {
    this.bar = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(ctx.extensionUri, "media", "gutter.svg"),
      gutterIconSize: "contain",
      overviewRulerColor: "rgba(217,119,87,0.6)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    ctx.subscriptions.push(this.bar);
  }

  /** 白板变了：重建索引 */
  readonly rebuild = debounce(async () => {
    await this.marks.rebuild(this.store);
    this.emitter.fire();
    await this.decorate();
  }, 300);

  readonly redecorate = debounce(() => void this.decorate(), 200);

  private async decorate() {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== "file") continue;
      const lines = await this.marks.lines(ed.document.uri.fsPath, this.panels.target);
      ed.setDecorations(this.bar, lines.map(([s, e]) => new vscode.Range(s - 1, 0, e - 1, 0)));
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== "file") return [];
    return this.marks.lenses(doc.uri.fsPath, doc.languageId, () => doc.getText(), this.panels.target).map((l) => {
      const r = new vscode.Range(l.line - 1, 0, l.line - 1, 0);
      return new vscode.CodeLens(r, { title: l.title, tooltip: l.tooltip, command: l.command, arguments: l.args });
    });
  }
}
