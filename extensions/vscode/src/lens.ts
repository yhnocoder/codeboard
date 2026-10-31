import * as vscode from "vscode";
import { BoardMarks, debounce, type BoardHub, type Storage } from "@codeboard/host";

type Mode = "all" | "lens" | "off";
const mode = (): Mode => {
  const m = vscode.workspace.getConfiguration("codeboard").get<string>("editorMarks");
  return m === "lens" || m === "off" ? m : "all";
};

export class EditorMarks implements vscode.CodeLensProvider {
  private marks = new BoardMarks();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private bar: vscode.TextEditorDecorationType;

  constructor(
    ctx: vscode.ExtensionContext,
    private store: Storage,
    private panels: BoardHub,
  ) {
    this.bar = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(ctx.extensionUri, "media", "gutter.svg"),
      gutterIconSize: "contain",
      overviewRulerColor: "rgba(217,119,87,0.6)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    ctx.subscriptions.push(this.bar);
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("codeboard.editorMarks")) return;
        this.emitter.fire();
        void this.decorate();
      }),
    );
  }

  readonly rebuild = debounce(async () => {
    await this.marks.rebuild(this.store);
    this.emitter.fire();
    await this.decorate();
  }, 300);

  readonly redecorate = debounce(() => void this.decorate(), 200);

  private async decorate() {
    const bar = mode() === "all";
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== "file") continue;
      if (!bar) {
        ed.setDecorations(this.bar, []);
        continue;
      }
      const lines = await this.marks.lines(ed.document.uri.fsPath, this.panels.target);
      ed.setDecorations(
        this.bar,
        lines.map(([s, e]) => new vscode.Range(s - 1, 0, e - 1, 0)),
      );
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== "file" || mode() === "off") return [];
    return this.marks
      .lenses(doc.uri.fsPath, doc.languageId, () => doc.getText(), this.panels.target)
      .map((l) => {
        const r = new vscode.Range(l.line - 1, 0, l.line - 1, 0);
        return new vscode.CodeLens(r, { title: l.title, tooltip: l.tooltip, command: l.command, arguments: l.args });
      });
  }
}
