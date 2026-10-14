import * as vscode from "vscode";
import { cardTitle, outlineTree, type BoardMeta, type OutlineNode } from "@codeboard/core";
import type { Storage } from "./storage";
import type { BoardPanel } from "./board";

type Node =
  | { kind: "board"; meta: BoardMeta }
  | { kind: "card"; board: string; node: OutlineNode };

/** 侧栏：所有白板，展开后是按箭头关系排好的大纲 */
export class BoardsTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;
  constructor(private store: Storage, private panel: BoardPanel) {}

  refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 250);
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) return (await this.store.list()).map((meta) => ({ kind: "board", meta }));
    if (n.kind === "board") {
      const b = this.panel.board?.id === n.meta.id ? this.panel.board : await this.store.load(n.meta.id);
      return b ? outlineTree(b).map((node) => ({ kind: "card", board: n.meta.id, node })) : [];
    }
    return n.node.kids.map((node) => ({ kind: "card", board: n.board, node }));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "board") {
      const cur = this.panel.board?.id === n.meta.id;
      const it = new vscode.TreeItem(n.meta.name, cur ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.id = `b:${n.meta.id}:${cur ? 1 : 0}`;
      it.contextValue = "board";
      it.iconPath = new vscode.ThemeIcon(cur ? "window" : "layout");
      it.description = cur ? "已打开" : undefined;
      it.command = { command: "codeboard.openBoard", title: "打开", arguments: [n.meta.id] };
      return it;
    }
    const c = n.node.card;
    const it = new vscode.TreeItem(cardTitle(c), n.node.kids.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    it.id = `c:${n.board}:${c.id}`;
    it.description = [c.step, `${c.path.split("/").pop()}:${c.start}`].filter(Boolean).join("  ");
    it.tooltip = `${c.path}:${c.start}–${c.end}`;
    it.iconPath = new vscode.ThemeIcon(c.symbol ? "symbol-method" : "symbol-snippet");
    it.command = { command: "codeboard.focusCard", title: "在白板上查看", arguments: [n.board, c.id] };
    return it;
  }
}
