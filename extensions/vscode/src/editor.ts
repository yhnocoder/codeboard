import * as vscode from "vscode";
import { cardTitle, type CodeCard } from "@codeboard/core";
import type { BoardPanel } from "./board";
import { relPath } from "./code";

/** 卡片在当前代码里的位置（按最近一次同步状态） */
function placeOf(panel: BoardPanel, c: CodeCard): { start: number; end: number; delta: number } | null {
  const s = panel.views[c.id]?.sync;
  if (!s || s.state === "ok") return { start: c.start, end: c.end, delta: 0 };
  if (s.state === "moved" || s.state === "changed") return { start: s.start, end: s.end, delta: s.state === "moved" ? s.start - c.start : NaN };
  return null;
}

/**
 * 编辑器里标出白板上已有的代码：左侧一道陶土色细线，显式高亮的行加底色；
 * 函数卡片上方有一个 CodeLens，点一下回到白板上的那张卡片。
 */
export class EditorMarks implements vscode.CodeLensProvider {
  private range = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px", borderStyle: "solid", borderColor: "rgba(217,119,87,0.55)",
    overviewRulerColor: "rgba(217,119,87,0.6)", overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private hl = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: "rgba(217,119,87,0.10)" });
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private panel: BoardPanel) {}

  update() {
    for (const ed of vscode.window.visibleTextEditors) {
      const rel = relPath(ed.document.uri.fsPath);
      const cards = this.panel.codeCards().filter((c) => c.path === rel);
      const ranges: vscode.DecorationOptions[] = [], hls: vscode.Range[] = [];
      for (const c of cards) {
        const p = placeOf(this.panel, c);
        if (!p) continue;
        ranges.push({ range: new vscode.Range(p.start - 1, 0, p.end - 1, 0), hoverMessage: `在白板「${this.panel.board?.name}」上：${cardTitle(c)}` });
        if (!Number.isNaN(p.delta)) for (const l of c.hl) hls.push(new vscode.Range(l + p.delta - 1, 0, l + p.delta - 1, 0));
      }
      ed.setDecorations(this.range, ranges);
      ed.setDecorations(this.hl, hls);
    }
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const rel = relPath(doc.uri.fsPath);
    const out: vscode.CodeLens[] = [];
    for (const c of this.panel.codeCards()) {
      if (c.path !== rel) continue;
      const p = placeOf(this.panel, c);
      if (!p || p.start > doc.lineCount) continue;
      const changed = this.panel.views[c.id]?.sync.state === "changed";
      out.push(new vscode.CodeLens(new vscode.Range(p.start - 1, 0, p.start - 1, 0), {
        title: `$(layout) 在白板上${c.step ? ` · ${c.step}` : ""}${changed ? " · 有新版本" : ""}`,
        command: "codeboard.focusCard",
        arguments: [this.panel.board?.id, c.id],
      }));
    }
    return out;
  }
}
