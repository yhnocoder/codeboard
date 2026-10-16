// 白板存储（第 2 版）：一张白板一个 JSON，组 = 子文件夹（只有一层），图片放 assets/。
// 默认放在 VS Code 给这个工作区的存储目录里（boards/），不往正在读的仓库里写；codeboard.storageDir 可以换位置。
// 第 1 版的白板文件读进来时用 migrateBoard 迁移，下次保存写成第 2 版。
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { allCodeCards, emptyBoard, migrateBoard, type Board, type BoardMeta } from "@codeboard/core";
import { mkUid } from "./ws";
import { log } from "./log";

const badFiles = new Set<string>();

type Entry = { id: string; file: string; group?: string; mtime: number; birth: number; board: Board };

const RESERVED = new Set(["assets", "github", ".trash"]);
/** 组名就是子文件夹名：去掉路径符号；"."、".." 和点开头的（.trash）、保留名都不行 */
function groupName(name: string): string | null {
  const safe = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return safe && !safe.startsWith(".") && !RESERVED.has(safe) ? safe : null;
}
/** 白板 id 也是文件名：只允许字母、数字、- 和 _ */
const SAFE_ID = /^[\w-]{1,80}$/;

export class Storage {
  private changed = new vscode.EventEmitter<void>();
  /** 白板列表变了（增删、改名、分组、卡片数） */
  readonly onDidChange = this.changed.event;
  private saved = new vscode.EventEmitter<Board>();
  /** 任何一次保存（CodeLens、行号旁标记要跟着变） */
  readonly onDidSave = this.saved.event;
  private cache = new Map<string, Entry>();
  /** 每张白板有新版本的卡片数（版本模块算好填进来） */
  readonly stale = new Map<string, number>();
  private emptyGroups = new Set<string>();

  constructor(private ctx: vscode.ExtensionContext) {}

  dir(): string {
    const set = vscode.workspace.getConfiguration("codeboard").get<string>("storageDir")?.trim();
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (set) {
      const p = set.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
      return path.isAbsolute(p) || !ws ? p : path.join(ws, p);
    }
    return path.join((this.ctx.storageUri ?? this.ctx.globalStorageUri).fsPath, "boards");
  }
  assetsDir() { return path.join(this.dir(), "assets"); }
  /** GitHub 文件缓存：按 commit 存，不会变，所有工作区共用 */
  githubDir() { return path.join(this.ctx.globalStorageUri.fsPath, "github"); }

  /** 扫描存储目录（按修改时间缓存解析结果） */
  private async scan(): Promise<Entry[]> {
    const root = this.dir();
    const files: { file: string; group?: string }[] = [];
    let names: import("node:fs").Dirent[] = [];
    try { names = await fs.readdir(root, { withFileTypes: true }); } catch { /* 还没有目录 */ }
    for (const d of names) {
      if (d.isFile() && d.name.endsWith(".json")) files.push({ file: path.join(root, d.name) });
      else if (d.isDirectory() && !RESERVED.has(d.name) && !d.name.startsWith(".")) {
        this.emptyGroups.add(d.name);
        let sub: string[] = [];
        try { sub = await fs.readdir(path.join(root, d.name)); } catch { /* */ }
        for (const n of sub) if (n.endsWith(".json")) files.push({ file: path.join(root, d.name, n), group: d.name });
      }
    }
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const f of files) {
      try {
        const st = await fs.stat(f.file);
        let e = [...this.cache.values()].find((x) => x.file === f.file);
        if (!e || e.mtime !== st.mtimeMs) {
          const raw = JSON.parse(await fs.readFile(f.file, "utf8"));
          const board = migrateBoard(raw);
          // id 决定存盘的文件名：只认安全的 id；和别的文件重了（Finder 里复制出来的）就换一个新的，免得两份互相覆盖
          const base = path.basename(f.file, ".json");
          if (!SAFE_ID.test(board.id ?? "")) board.id = SAFE_ID.test(base) ? base : mkUid("b");
          else if (board.id !== base && files.some((g) => path.basename(g.file, ".json") === board.id)) board.id = mkUid("b");
          if (seen.has(board.id)) board.id = mkUid("b");
          board.sidenotes ??= [];
          board.sections ??= [];
          board.links ??= [];
          e = { id: board.id, file: f.file, group: f.group, mtime: st.mtimeMs, birth: st.birthtimeMs || st.ctimeMs, board };
          this.cache.set(board.id, e);
        }
        e.group = f.group;
        seen.add(e.id);
        out.push(e);
      } catch (e) { if (!badFiles.has(f.file)) { badFiles.add(f.file); log("error", `storage: skipped unreadable board ${f.file}: ${e instanceof Error ? e.message : e}`); } } // 坏文件跳过（只记一次）
    }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
    return out.sort((a, b) => a.birth - b.birth);
  }

  async list(): Promise<BoardMeta[]> {
    return (await this.scan()).map((e) => this.meta(e));
  }

  private meta(e: Entry): BoardMeta {
    return { id: e.id, name: e.board.name, group: e.group, cards: e.board.cards.length, stale: this.stale.get(e.id) || undefined };
  }

  /** 所有白板（搜索、CodeLens、Reveal 用） */
  async all(): Promise<{ board: Board; group?: string }[]> {
    return (await this.scan()).map((e) => ({ board: e.board, group: e.group }));
  }

  async groups(): Promise<string[]> {
    await this.scan();
    return [...this.emptyGroups].sort();
  }

  async load(id: string): Promise<Board | null> {
    await this.scan();
    const e = this.cache.get(id);
    return e ? structuredClone(e.board) : null;
  }

  async save(b: Board, opts: { group?: string | null } = {}) {
    if (!SAFE_ID.test(b.id)) throw new Error(`Bad board id: ${b.id}`);
    const old = this.cache.get(b.id);
    const group = opts.group === undefined ? old?.group : opts.group ?? undefined;
    const dir = group ? path.join(this.dir(), group) : this.dir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${b.id}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(b, null, 1));
    await fs.rename(tmp, file);
    if (old && old.file !== file) await fs.rm(old.file, { force: true });
    const st = await fs.stat(file);
    const e: Entry = { id: b.id, file, group, mtime: st.mtimeMs, birth: old?.birth ?? Date.now(), board: structuredClone(b) };
    this.cache.set(b.id, e);
    this.saved.fire(e.board);
    if (!old || outline(old.board) !== outline(b) || old.group !== group) this.changed.fire();
  }

  async create(name: string, group?: string): Promise<Board> {
    const b = emptyBoard(mkUid("b"), name);
    await this.save(b, { group: group ?? null });
    return b;
  }

  async remove(id: string) {
    const e = this.cache.get(id);
    if (!e) return;
    // 放进 .trash，误删还能找回来
    const trash = path.join(this.dir(), ".trash");
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(e.file, path.join(trash, `${id}.${Date.now()}.json`)).catch(() => fs.rm(e.file, { force: true }));
    this.cache.delete(id);
    this.changed.fire();
  }

  async rename(id: string, name: string) {
    const b = await this.load(id);
    if (!b) return;
    b.name = name;
    await this.save(b);
  }

  async duplicate(id: string): Promise<Board | null> {
    const b = await this.load(id);
    if (!b) return null;
    const nb: Board = { ...structuredClone(b), id: mkUid("b"), name: `${b.name} copy` };
    await this.save(nb, { group: this.cache.get(id)?.group ?? null });
    return nb;
  }

  async move(id: string, group: string | undefined) {
    const b = await this.load(id);
    const g = group === undefined ? null : groupName(group);
    if (group !== undefined && !g) return;
    if (b) await this.save(b, { group: g });
  }

  groupOf(id: string) { return this.cache.get(id)?.group; }
  fileOf(id: string) { return this.cache.get(id)?.file; }

  async newGroup(name: string) {
    const safe = groupName(name);
    if (!safe) return;
    await fs.mkdir(path.join(this.dir(), safe), { recursive: true });
    this.emptyGroups.add(safe);
    this.changed.fire();
  }

  async renameGroup(from: string, to: string) {
    const safe = groupName(to);
    if (!safe || !groupName(from)) return;
    await fs.rename(path.join(this.dir(), from), path.join(this.dir(), safe));
    this.emptyGroups.delete(from);
    this.cache.clear();
    this.changed.fire();
  }

  /** 删组：白板移回顶层，再删文件夹 */
  async removeGroup(name: string) {
    if (!groupName(name)) return; // ".." 之类会删到存储目录外面去
    for (const e of await this.scan()) if (e.group === name) await this.move(e.id, undefined);
    await fs.rm(path.join(this.dir(), name), { recursive: true, force: true });
    this.emptyGroups.delete(name);
    this.changed.fire();
  }

  /** 设置里换了目录 */
  reset() { this.cache.clear(); this.emptyGroups.clear(); this.changed.fire(); }

  fireChanged() { this.changed.fire(); }

  /** 存一张图片到 assets/，按内容去重；返回文件名 */
  async saveAsset(name: string, dataUrl: string): Promise<string> {
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) throw new Error("Not an image");
    const buf = Buffer.from(m[2], "base64");
    const { createHash } = await import("node:crypto");
    const ext = path.extname(name) || `.${(m[1].split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg")}`;
    const file = `${createHash("sha1").update(buf).digest("hex").slice(0, 16)}${ext.toLowerCase()}`;
    await fs.mkdir(this.assetsDir(), { recursive: true });
    await fs.writeFile(path.join(this.assetsDir(), file), buf);
    return file;
  }
}

/** 侧栏关心的部分：名字和卡片数 */
const outline = (b: Board) => JSON.stringify([b.name, b.cards.length, allCodeCards(b).length]);
