// 侧栏：BOARDS（组 = 文件夹，白板后面是卡片数，有新版本的卡时加圆点）和 GITHUB FILES（下载过的 GitHub 文件）。
import * as vscode from "vscode";
import * as path from "node:path";
import type { BoardMeta } from "@codeboard/core";
import { cachedFiles } from "./github";
import type { Panels } from "./panel";
import { githubFileDir } from "./source";
import type { Storage } from "./storage";
import { debounce } from "./ws";

type BNode = { kind: "group"; name: string } | { kind: "board"; id: string; meta: BoardMeta };

export class BoardsTree implements vscode.TreeDataProvider<BNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly refresh = debounce(() => this.emitter.fire(), 200);
  constructor(private store: Storage, private panels: Panels) {}

  async getChildren(n?: BNode): Promise<BNode[]> {
    const metas = await this.store.list();
    const board = (meta: BoardMeta): BNode => ({ kind: "board", id: meta.id, meta });
    if (!n) {
      const groups = await this.store.groups();
      return [...groups.map((name): BNode => ({ kind: "group", name })), ...metas.filter((m) => !m.group).map(board)];
    }
    if (n.kind === "group") return metas.filter((m) => m.group === n.name).map(board);
    return [];
  }

  getTreeItem(n: BNode): vscode.TreeItem {
    if (n.kind === "group") {
      const it = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded);
      it.id = `g:${n.name}`;
      it.contextValue = "group";
      it.iconPath = vscode.ThemeIcon.Folder;
      return it;
    }
    const m = n.meta;
    const it = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
    it.id = `b:${m.id}`;
    it.contextValue = "board";
    const open = !!this.panels.get(m.id), target = this.panels.target === m.id;
    it.iconPath = new vscode.ThemeIcon(target ? "layout-sidebar-right" : "layout", m.stale ? new vscode.ThemeColor("charts.orange") : undefined);
    it.description = `${m.cards}${m.stale ? ` ● ${m.stale}` : ""}`;
    it.tooltip = new vscode.MarkdownString([
      `**${m.name}**`, `${m.cards} cards`, m.stale ? `${m.stale} cards have new versions` : "", target ? "Target for Add to Board" : "", open ? "Open" : "",
    ].filter(Boolean).join("  \n"));
    it.command = { command: "codeboard.openBoard", title: "Open", arguments: [m.id] };
    return it;
  }
}

type GNode = { kind: "repo"; owner: string; name: string; commit: string; ref: string; files: string[] } | { kind: "file"; abs: string; rel: string; cards: number };

export class GithubTree implements vscode.TreeDataProvider<GNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly refresh = debounce(() => this.emitter.fire(), 300);
  constructor(private store: Storage) {}

  async getChildren(n?: GNode): Promise<GNode[]> {
    if (!n) return (await cachedFiles()).map((r) => ({ kind: "repo", ...r }));
    if (n.kind !== "repo") return [];
    // 每个文件上有几张卡
    const count = new Map<string, number>();
    for (const { board } of await this.store.all()) for (const c of board.cards) {
      if (c.kind !== "code") continue;
      const s = c.segments.find((x) => x.src.kind === "github" && x.src.owner === n.owner && x.src.name === n.name && x.version.kind === "git" && x.version.commit === n.commit);
      if (s) count.set(s.path, (count.get(s.path) ?? 0) + 1);
    }
    const dir = githubFileDir(n.owner, n.name, n.commit);
    return n.files.map((rel) => ({ kind: "file", abs: path.join(dir, rel), rel, cards: count.get(rel) ?? 0 }));
  }

  getTreeItem(n: GNode): vscode.TreeItem {
    if (n.kind === "repo") {
      const it = new vscode.TreeItem(`${n.owner}/${n.name}`, vscode.TreeItemCollapsibleState.Expanded);
      it.id = `r:${n.owner}/${n.name}/${n.commit}`;
      it.description = n.ref !== n.commit ? `${n.ref} · ${n.commit.slice(0, 7)}` : n.commit.slice(0, 7);
      it.iconPath = new vscode.ThemeIcon("github");
      return it;
    }
    const it = new vscode.TreeItem(n.rel, vscode.TreeItemCollapsibleState.None);
    it.id = `f:${n.abs}`;
    it.description = n.cards ? `${n.cards} card${n.cards > 1 ? "s" : ""}` : undefined;
    it.resourceUri = vscode.Uri.file(n.abs);
    it.command = { command: "codeboard.openGithubFile", title: "Open", arguments: [n.abs] };
    return it;
  }
}
