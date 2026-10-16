// 编辑器里的标记：CodeLens 只挂在白板上有的函数 / 类上方（「+ Card」「on N boards」），
// 目标白板上有的行在行号旁画一道细竖条。
import * as vscode from "vscode";
import { allCodeCards, type Segment } from "@codeboard/core";
import { analysisOf } from "./analysis";
import type { Panels } from "./panel";
import { absOf } from "./source";
import type { Storage } from "./storage";
import { workingPlace } from "./versions";
import { debounce } from "./ws";

type Entry = { board: string; card: string; seg: Segment };

export class EditorMarks implements vscode.CodeLensProvider {
  private byFile = new Map<string, Entry[]>();
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

  /** 白板变了：重建「文件 → 段」索引 */
  readonly rebuild = debounce(async () => {
    const m = new Map<string, Entry[]>();
    for (const { board } of await this.store.all()) {
      for (const c of allCodeCards(board)) for (const s of c.segments) {
        const abs = s.src.kind === "free" ? null : absOf(s);
        if (abs) (m.get(abs) ?? m.set(abs, []).get(abs)!).push({ board: board.id, card: c.id, seg: s });
      }
    }
    this.byFile = m;
    this.emitter.fire();
    await this.decorate();
  }, 300);

  readonly redecorate = debounce(() => void this.decorate(), 200);

  private async decorate() {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== "file") continue;
      const ents = (this.byFile.get(ed.document.uri.fsPath) ?? []).filter((e) => e.board === this.panels.target);
      const ranges: vscode.Range[] = [];
      for (const e of ents) {
        const wp = await workingPlace(e.seg);
        if (wp) ranges.push(new vscode.Range(wp.start - 1, 0, wp.end - 1, 0));
      }
      ed.setDecorations(this.bar, ranges);
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const ents = this.byFile.get(doc.uri.fsPath);
    if (!ents?.length || doc.uri.scheme !== "file") return [];
    const out: vscode.CodeLens[] = [];
    for (const s of analysisOf(doc.languageId, doc.getText(), doc.uri.fsPath).symbols) {
      const on = ents.filter((e) => e.seg.symbol?.qual === s.qual);
      if (!on.length) continue;
      const boards = new Set(on.map((e) => e.board));
      const r = new vscode.Range(s.defLine - 1, 0, s.defLine - 1, 0);
      if (!boards.has(this.panels.target ?? "")) out.push(new vscode.CodeLens(r, { title: "+ Card", tooltip: "Add to the target board", command: "codeboard.addSymbol", arguments: [doc.uri, s.qual] }));
      out.push(new vscode.CodeLens(r, { title: `on ${boards.size} board${boards.size > 1 ? "s" : ""}`, tooltip: "Reveal on Board", command: "codeboard.revealSymbol", arguments: [doc.uri, s.start, s.end] }));
    }
    return out;
  }
}

