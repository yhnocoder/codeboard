import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { emptyBoard, type Board, type BoardMeta } from "@codeboard/core";

/**
 * 白板存成 JSON，一张白板一个文件。默认放在 VS Code 给这个工作区的存储目录里，
 * 不往正在读的仓库里写东西；设置 codeboard.storageDir 可以换位置（比如放进自己的笔记仓库）。
 */
export class Storage {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  constructor(private ctx: vscode.ExtensionContext) {}

  dir(): string {
    const set = vscode.workspace.getConfiguration("codeboard").get<string>("storageDir")?.trim();
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (set) return path.isAbsolute(set) || !ws ? set : path.join(ws, set);
    return path.join((this.ctx.storageUri ?? this.ctx.globalStorageUri).fsPath, "boards");
  }
  private file(id: string) {
    return path.join(this.dir(), `${id}.json`);
  }

  async list(): Promise<BoardMeta[]> {
    let names: string[] = [];
    try { names = (await fs.readdir(this.dir())).filter((n) => n.endsWith(".json")); } catch { return []; }
    const out: (BoardMeta & { t: number })[] = [];
    for (const n of names) {
      try {
        const f = path.join(this.dir(), n);
        const b = JSON.parse(await fs.readFile(f, "utf8")) as Board;
        out.push({ id: b.id, name: b.name, t: (await fs.stat(f)).birthtimeMs });
      } catch { /* 坏文件跳过 */ }
    }
    return out.sort((a, b) => a.t - b.t).map(({ id, name }) => ({ id, name }));
  }

  async load(id: string): Promise<Board | null> {
    try { return JSON.parse(await fs.readFile(this.file(id), "utf8")) as Board; } catch { return null; }
  }

  async save(b: Board, quiet = false) {
    await fs.mkdir(this.dir(), { recursive: true });
    const old = await this.load(b.id);
    await fs.writeFile(this.file(b.id), JSON.stringify(b, null, 1));
    // 只有名字或卡片结构变了才刷新侧栏，拖动卡片不刷新
    if (!quiet && (!old || old.name !== b.name || outlineKey(old) !== outlineKey(b))) this.emitter.fire();
  }

  async create(name: string): Promise<Board> {
    const id = `b${Date.now().toString(36)}`;
    const b = emptyBoard(id, name);
    await this.save(b);
    return b;
  }

  async remove(id: string) {
    await fs.rm(this.file(id), { force: true });
    this.emitter.fire();
  }
}

const outlineKey = (b: Board) =>
  JSON.stringify([b.cards.map((c) => (c.type === "code" ? [c.id, c.step, c.symbol, c.title, c.path] : c.id)), b.edges.map((e) => [e.from, e.to])]);
