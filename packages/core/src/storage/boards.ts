// 白板存储（第 2 版起的目录结构）：一张白板一个 JSON，组 = 子文件夹（只有一层），图片放 assets/，删掉的放 .trash/。
// 目录在哪由宿主决定（dir()）；读写都经过 Fs 适配器。旧版本的白板文件读进来时迁移，下次保存写成当前版本。
// 第 6 版起还是卡库（Library）：共享卡放 cards/<id>.json，白板文件里只留引用。这里缓存的、交出去的都是换上了内容的完整白板；
// 写盘时再拆开（deflate），共享卡按项和磁盘上的合并后写卡文件，再通知开着同一张卡的别的白板（onDidShare）。
// 白板发来的改动（patch）马上改缓存里的那份，稍后写盘（WRITE_DELAY 里的改动合成一次写）；关面板、退出时 flush() 把没写的写下去。
// 存储目录有人在外面（另一个窗口）写了：白板文件三方合并进缓存（onDidMerge），卡库里的卡换进有它的白板（onDidShare），不等这边存盘。
import { allCodeCards, baseName, BOARD_VERSION, emptyBoard, uid, withCols, type Board, type BoardFile, type BoardMeta, type Link, type SharedCard, type SharedCardFile } from "../model";
import { Emitter, type Disposable } from "../emitter";
import type { WorkspaceFiles } from "../workspace";
import { loadBoardFile, loadSharedCard } from "../schema";
import { applyPatch, applySharedUpdate, cardCopies, deflate, diffBoards, inflate, mergeById, mergeFile, putShared, same, sharedOf, travels, type BoardPatch, type SharedUpdate } from "../patch";
import { pruneRefs, removeCards, renameCard, unlinkCard, type CardCopy } from "../edit";
import { subBoardsOf } from "../subboard";
import { dirName, extName, type Fs } from "./fs";

/** 写之前的样子（文件在哪、侧栏关心的部分、组）：写完比一比，侧栏要不要刷新、旧文件要不要删 */
type Prev = { file: string; outline: string; group?: string };
/**
 * refs = 这块白板上的共享卡；used = 换进来的是卡库里的哪一版（卡文件在外面被改了时重新换）；
 * held = 这块白板放过、或贴过来的共享卡（refs 只增不减的那一份）：Remove from Board 之后撤销、贴过来的共享卡第一次存盘，按它认回共享卡；
 * text = 白板文件上次读到 / 写下的内容（另一个窗口改了文件时按它三方合并）；
 * pending = 缓存里有还没写盘的改动（第一次改之前的样子）
 */
type Entry = { id: string; file: string; group?: string; mtime: number; birth: number; board: Board; refs: Set<string>; held: Set<string>; used: Map<string, SharedCardFile>; text?: string; pending?: Prev };
/**
 * 改了的共享卡（from = 这个窗口里哪块白板改的；没有 = 另一个窗口写的卡文件。别的开着这张卡的白板要跟着换）。
 * back = 写的这块白板自己也要换上的（卡文件被另一个窗口改过，合并进来了别人的项）
 */
export type SharedChange = { from?: string; cards: SharedUpdate[]; back?: SharedUpdate[] };

export type StorageOpts = {
  /** 存储目录（设置可能变，每次用时问） */
  dir: () => string;
  log?: (level: "info" | "warn" | "error", text: string) => void;
  /** 看着存储目录里的文件（宿主的 Workspace files.watch）：另一个窗口写了白板或共享卡，开着的白板马上换上。不给就只在读目录时发现 */
  watch?: WorkspaceFiles["watch"];
};

export const RESERVED = new Set(["assets", "github", "cards", "runs", ".trash"]);
/** 组名就是子文件夹名：去掉路径符号；"."、".." 和点开头的（.trash）、保留名都不行 */
export function groupName(name: string): string | null {
  const safe = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return safe && !safe.startsWith(".") && !RESERVED.has(safe) ? safe : null;
}
/** 白板 id 也是文件名：只允许字母、数字、- 和 _ */
export const SAFE_ID = /^[\w-]{1,80}$/;

/** 白板的改动攒多久写一次盘（ms）；写失败了隔多久再试 */
const WRITE_DELAY = 400, RETRY_DELAY = 5000;

export class Storage {
  private changed = new Emitter<void>();
  /** 白板列表变了（增删、改名、分组、卡片数） */
  readonly onDidChange = this.changed.event;
  private saved = new Emitter<Board>();
  /** 任何一次保存，和读进了另一个窗口写的白板文件（CodeLens、行号旁标记要跟着变） */
  readonly onDidSave = this.saved.event;
  private cache = new Map<string, Entry>();
  /** 每张白板有新版本的卡片数（版本模块算好填进来） */
  readonly stale = new Map<string, number>();
  private emptyGroups = new Set<string>();
  private badFiles = new Set<string>();
  private sharedEmitter = new Emitter<SharedChange>();
  /** 共享卡变了（写进了卡库）：开着同一张卡的别的白板要跟着换 */
  readonly onDidShare = this.sharedEmitter.event;
  private removedEmitter = new Emitter<{ from?: string; card: string; boards: string[] }>();
  /** Delete Everywhere 删掉了一张共享卡：开着的白板跟着删 */
  readonly onDidRemoveShared = this.removedEmitter.event;
  private mergedEmitter = new Emitter<{ id: string; patch: BoardPatch }>();
  /** 写盘时合并进了另一个窗口对这块白板文件的改动：开着它的面板跟着换上（patch = 从它发来的样子到合并后的样子） */
  readonly onDidMerge = this.mergedEmitter.event;
  private removedBoard = new Emitter<string>();
  /** 一块白板删掉了（放进了 .trash）：面包屑里有它的面板回不去了 */
  readonly onDidRemoveBoard = this.removedBoard.event;
  /** 卡库的缓存（按修改时间） */
  private lib = new Map<string, { mtime: number; sc: SharedCardFile }>();
  /** 共享的每一项（卡、Sidenote）最后是哪块白板写的：撤销时别的白板后来改过的项不撤（只在内存里，重启后撤销栈也没了） */
  private writer = new Map<string, string>();
  /** 写盘排队：两块白板同时保存时，卡文件按顺序合并 */
  private q: Promise<unknown> = Promise.resolve();
  /** 有没写盘改动的白板 → 写盘的定时器 */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private failedEmitter = new Emitter<{ board: string; error: string }>();
  /** 白板的改动写不下去（磁盘满、没权限）：过一会儿自动重试，开着这块白板的面板要说一声。一直写不下去时只在第一次说 */
  readonly onDidFailSave = this.failedEmitter.event;
  private recoveredEmitter = new Emitter<string>();
  /** 写不下去的白板又写下去了（说过写不下去的才说） */
  readonly onDidRecoverSave = this.recoveredEmitter.event;
  /** 正写不下去的白板 */
  private failing = new Set<string>();
  /** 正在看着的存储目录（设置里换了目录时换一个） */
  private watched?: { dir: string; sub: Disposable };

  constructor(private fs: Fs, private opts: StorageOpts) { this.watchDir(); }

  /** 不再看着存储目录 */
  dispose() { this.watched?.sub.dispose(); this.watched = undefined; }

  /** 看着现在的存储目录（建好时；设置里换了目录时 reset 换过去） */
  private watchDir() {
    const dir = this.dir();
    if (!this.opts.watch) return;
    this.dispose();
    this.watched = { dir, sub: this.opts.watch(dir, "**/*.json", (abs) => void this.serial(() => this.changedOnDisk(abs)).catch((e) => this.opts.log?.("error", `storage: ${abs}: ${e instanceof Error ? e.message : e}`))) };
  }

  /**
   * 存储目录里的一个 .json 变了（新建、改、删）。自己写的（mtime、内容和上次写下的一样）不算：
   * 开着的白板的文件 → 三方合并进来（pull）；卡库里的卡 → 换进有它的白板（pullShared）；别的白板文件（新的、删掉的）→ 侧栏重新列
   */
  private async changedOnDisk(abs: string) {
    const root = this.dir(), dir = dirName(abs), name = baseName(abs);
    if (dir === this.cardsDir()) return this.pullShared(name.slice(0, -".json".length));
    const group = dir === root ? "" : dirName(dir) === root ? baseName(dir) : null;
    if (group === null || RESERVED.has(group) || group.startsWith(".")) return;
    const e = [...this.cache.values()].find((x) => x.file === abs);
    const there = await this.fs.stat(abs).then(() => true, () => false);
    if (e && there) await this.pull(e);
    else this.changed.fire();
  }

  dir(): string { return this.opts.dir(); }
  assetsDir() { return this.fs.join(this.dir(), "assets"); }
  cardsDir() { return this.fs.join(this.dir(), "cards"); }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.q.then(fn);
    this.q = r.catch(() => undefined);
    return r;
  }

  /** 卡库里的一张卡（按修改时间缓存）；没有或读不了返回 undefined */
  private async readShared(id: string): Promise<SharedCardFile | undefined> {
    if (!SAFE_ID.test(id)) return undefined;
    const file = this.fs.join(this.cardsDir(), `${id}.json`);
    let mtime: number;
    try { mtime = (await this.fs.stat(file)).mtimeMs; } catch { this.lib.delete(id); return undefined; }
    const c = this.lib.get(id);
    if (c && c.mtime === mtime) return c.sc;
    try {
      const sc = loadSharedCard(JSON.parse(await this.fs.readFile(file)));
      sc.card.id = id; // 文件名说了算
      this.lib.set(id, { mtime, sc });
      return sc;
    } catch (e) {
      if (!this.badFiles.has(file)) { this.badFiles.add(file); this.opts.log?.("error", `storage: unreadable shared card ${file}: ${e instanceof Error ? e.message : e}`); }
      return undefined;
    }
  }

  private async writeShared(sc: SharedCardFile) {
    const fs = this.fs;
    await fs.mkdir(this.cardsDir());
    const file = fs.join(this.cardsDir(), `${sc.card.id}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(sc, null, 1));
    await fs.rename(`${file}.tmp`, file);
    this.lib.set(sc.card.id, { mtime: (await fs.stat(file)).mtimeMs, sc });
  }

  /** 扫描存储目录（按修改时间缓存解析结果） */
  private async scan(): Promise<Entry[]> {
    const fs = this.fs;
    const root = this.dir();
    const files: { file: string; group?: string }[] = [];
    let names: Awaited<ReturnType<Fs["readdir"]>> = [];
    try { names = await fs.readdir(root); } catch { /* 还没有目录 */ }
    for (const d of names) {
      if (d.isFile && d.name.endsWith(".json")) files.push({ file: fs.join(root, d.name) });
      else if (d.isDir && !RESERVED.has(d.name) && !d.name.startsWith(".")) {
        this.emptyGroups.add(d.name);
        let sub: string[] = [];
        try { sub = (await fs.readdir(fs.join(root, d.name))).map((x) => x.name); } catch { /* */ }
        for (const n of sub) if (n.endsWith(".json")) files.push({ file: fs.join(root, d.name, n), group: d.name });
      }
    }
    const seen = new Set<string>();
    const out: Entry[] = [];
    const idOf = (file: string) => baseName(file).slice(0, -".json".length);
    for (const f of files) {
      try {
        const st = await fs.stat(f.file);
        let e = [...this.cache.values()].find((x) => x.file === f.file);
        // 另一个窗口改了文件：三方合并进缓存（没写盘的改动留着），开着的面板跟着换上
        if (e && e.mtime !== st.mtimeMs) await this.pull(e);
        if (!e) {
          const text = await fs.readFile(f.file);
          const raw = JSON.parse(text);
          const board = loadBoardFile(raw);
          // id 决定存盘的文件名：只认安全的 id；和别的文件重了（Finder 里复制出来的）就换一个新的，免得两份互相覆盖
          const base = idOf(f.file);
          if (!SAFE_ID.test(board.id ?? "")) board.id = SAFE_ID.test(base) ? base : uid("b");
          else if (board.id !== base && files.some((g) => idOf(g.file) === board.id)) board.id = uid("b");
          if (seen.has(board.id)) board.id = uid("b");
          // 共享卡：引用换成卡库里的内容
          const used = new Map<string, SharedCardFile>();
          for (const c of board.cards) if (c.kind === "shared") { const sc = await this.readShared(c.id); if (sc) used.set(c.id, sc); }
          const r = inflate(board, (id) => { const sc = used.get(id); return sc && structuredClone({ card: sc.card, sidenotes: sc.sidenotes }); });
          if (r.missing.length) this.opts.log?.("warn", `storage: board ${f.file} refers to missing shared cards ${r.missing.join(", ")}`);
          e = { id: board.id, file: f.file, group: f.group, mtime: st.mtimeMs, birth: st.birthtimeMs || st.ctimeMs, board: r.board, refs: new Set(r.refs), held: new Set(r.refs), used, text };
          this.cache.set(board.id, e);
        } else {
          // 卡库里的卡可能在外面改了
          for (const id of [...e.refs]) await this.pullShared(id);
        }
        e.group = f.group;
        seen.add(e.id);
        out.push(e);
      } catch (e) { // 坏文件跳过（只记一次）
        if (!this.badFiles.has(f.file)) { this.badFiles.add(f.file); this.opts.log?.("error", `storage: skipped unreadable board ${f.file}: ${e instanceof Error ? e.message : e}`); }
      }
    }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
    return out.sort((a, b) => a.birth - b.birth);
  }

  async list(): Promise<BoardMeta[]> {
    return (await this.scan()).map((e) => this.meta(e));
  }

  private meta(e: Entry): BoardMeta {
    const subs = subBoardsOf(e.board);
    return { id: e.id, name: e.board.name, group: e.group, cards: e.board.cards.length, stale: this.stale.get(e.id) || undefined, subs: subs.length ? subs : undefined };
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

  /** 缓存里的白板（不拷贝，只读）：开着的面板用它当宿主这边的那一份 */
  peek(id: string): Board | undefined { return this.cache.get(id)?.board; }

  /** 整块白板写盘（宿主自己改的白板、新建、改名、移组）。refs：新白板上哪些卡是共享卡（复制白板时）；已有的白板沿用它的 */
  async save(b: Board, opts: { group?: string | null; refs?: Iterable<string> } = {}) {
    if (!SAFE_ID.test(b.id)) throw new Error(`Bad board id: ${b.id}`);
    return this.serial(async () => {
      const old = this.cache.get(b.id);
      const group = opts.group === undefined ? old?.group : opts.group ?? undefined;
      const board = structuredClone(b);
      const ids = new Set(board.cards.map((c) => c.id));
      const refs = new Set([...(opts.refs ?? old?.refs ?? [])].filter((id) => ids.has(id)));
      const e: Entry = { id: b.id, file: old?.file ?? "", group, mtime: old?.mtime ?? 0, birth: old?.birth ?? Date.now(), board, refs, held: new Set([...refs, ...(old?.held ?? [])]), used: new Map(old?.used), text: old?.text };
      // 新白板（复制出来的）上的共享卡：它看到的就是卡库里现在的那份
      for (const id of refs) { const sc = this.lib.get(id)?.sc; if (sc && !e.used.has(id)) e.used.set(id, sc); }
      await this.commit(e, old && prevOf(old));
    });
  }

  /**
   * 白板发来的增量改动（BoardPatch）：马上改缓存里的那份，WRITE_DELAY 之后写盘（flush() 立刻写）。返回要还给这块白板的共享卡
   * （undo 时跳过了的项：别的白板后来改过，宿主这边留着别人的版本，白板要换回来）
   */
  async patch(id: string, p: BoardPatch, o: { undo?: boolean } = {}): Promise<SharedUpdate[]> {
    return this.serial(async () => {
      const e = await this.entry(id);
      const was = prevOf(e);
      const skipped = o.undo && !p.full ? this.dropStale(e, p) : new Map<string, string[]>();
      applyPatch(e.board, p);
      const ids = new Set(e.board.cards.map((c) => c.id));
      for (const r of [...e.refs]) if (!ids.has(r)) e.refs.delete(r); // Remove from Board：卡库里的卡不动
      // 认回共享卡：贴过来的共享卡（offer）、撤销 Remove from Board 回来的卡
      for (const c of p.cards?.set ?? []) if (e.held.has(c.id)) e.refs.add(c.id);
      this.dirty(e, was);
      const out: SharedUpdate[] = [];
      for (const [c, items] of skipped) { const sc = sharedOf(e.board, c); if (sc) out.push({ ...structuredClone(sc), items }); }
      return out;
    });
  }

  /** 缓存里的这块白板有了没写盘的改动（was = 改之前的样子）：稍后写 */
  private dirty(e: Entry, was: Prev) {
    e.pending ??= was;
    this.writeLater(e.id, WRITE_DELAY);
  }

  private writeLater(id: string, ms: number) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => void this.flush(id), ms));
  }

  /** 把缓存里还没写盘的改动写下去（id 缺省 = 所有白板）：关面板、退出前调用，平时 patch 之后的定时器调。写失败的过一会儿再试 */
  flush(id?: string): Promise<void> {
    return this.serial(() => this.writePending(id));
  }
  /** flush 的本体（已经在写盘队列里时直接调） */
  private async writePending(id?: string) {
    for (const e of [...this.cache.values()]) {
      if (!e.pending || (id !== undefined && e.id !== id)) continue;
      try { await this.commit(e, e.pending); } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.opts.log?.("error", `storage: couldn't save board ${e.id}: ${error}`);
        if (!this.failing.has(e.id)) { this.failing.add(e.id); this.failedEmitter.fire({ board: e.id, error }); }
        this.writeLater(e.id, RETRY_DELAY);
      }
    }
  }

  /** 撤销发来的改动里，共享的项如果最后是别的白板写的，就不撤（从 p 里拿掉）；返回 共享卡 → 跳过的项 */
  private dropStale(e: Entry, p: BoardPatch): Map<string, string[]> {
    const other = (item: string) => { const w = this.writer.get(item); return w !== undefined && w !== e.id; };
    const out = new Map<string, string[]>();
    const skip = (card: string, item: string) => out.set(card, [...(out.get(card) ?? []), item]);
    if (p.cards?.set) p.cards.set = p.cards.set.filter((c) => { if (!e.refs.has(c.id) || !other(c.id)) return true; skip(c.id, c.id); return false; });
    const cur = new Map(e.board.sidenotes.map((n) => [n.id, n]));
    /** 这条 Sidenote（宿主这边的或发来的）跟着哪张共享卡 */
    const cardOf = (...ns: (Board["sidenotes"][number] | undefined)[]) => ns.find((n) => n && e.refs.has(n.at.card) && travels(n, n.at.card))?.at.card;
    const keep = (id: string, n?: Board["sidenotes"][number]) => {
      const card = cardOf(cur.get(id), n);
      if (!card || !other(id)) return true;
      skip(card, id);
      return false;
    };
    if (p.sidenotes?.set) p.sidenotes.set = p.sidenotes.set.filter((n) => keep(n.id, n));
    if (p.sidenotes?.del) p.sidenotes.del = p.sidenotes.del.filter((id) => keep(id));
    return out;
  }

  /**
   * 写盘：共享卡按项和卡库里的合并（merged）、写卡文件（先写卡，再写白板文件），别的白板缓存里的同一张卡跟着换，发 onDidShare。
   * prev = 写之前的样子（文件在哪、侧栏关心的部分、组）；新白板没有
   */
  private async commit(e: Entry, prev?: Prev) {
    const fs = this.fs;
    const { file: data, shared } = deflate(e.board, e.refs);
    const changed: SharedUpdate[] = [];
    const back: SharedUpdate[] = [];
    for (const sc of shared) {
      const disk = await this.readShared(sc.card.id);
      const m = merged(e.used.get(sc.card.id), disk, sc);
      for (const item of m.mine) this.writer.set(item, e.id);
      if (!m.file) continue;
      await this.writeShared(m.file);
      e.used.set(sc.card.id, m.file);
      changed.push({ card: m.file.card, sidenotes: m.file.sidenotes, items: m.items });
      // 卡文件被另一个窗口改过：这块白板也换上合并后的那份
      if (m.back.length) { putShared(e.board, structuredClone({ card: m.file.card, sidenotes: m.file.sidenotes })); back.push({ ...structuredClone({ card: m.file.card, sidenotes: m.file.sidenotes }), items: m.back }); }
    }
    const fromDisk = await this.mergeDisk(e, data);
    // 写在它现在的文件夹里（存储目录刚换过时还是原来那个）；新白板、换了组的写到组的文件夹。文件名就是 id
    const dir = prev?.file && prev.group === e.group ? dirName(prev.file) : e.group ? fs.join(this.dir(), e.group) : this.dir();
    await fs.mkdir(dir);
    const file = fs.join(dir, `${e.id}.json`);
    const tmp = `${file}.tmp`;
    e.text = JSON.stringify(fromDisk?.file ?? data, null, 1);
    await fs.writeFile(tmp, e.text);
    await fs.rename(tmp, file);
    if (prev?.file && prev.file !== file) await fs.rm(prev.file);
    e.file = file;
    e.mtime = (await fs.stat(file)).mtimeMs;
    e.pending = undefined;
    clearTimeout(this.timers.get(e.id));
    this.cache.set(e.id, e);
    if (this.failing.delete(e.id)) this.recoveredEmitter.fire(e.id);
    for (const sc of changed) {
      const id = sc.card.id;
      for (const o of this.cache.values()) if (o !== e && o.refs.has(id)) this.take(o, this.lib.get(id)!.sc);
    }
    this.saved.fire(e.board);
    if (fromDisk?.patch) this.mergedEmitter.fire({ id: e.id, patch: structuredClone(fromDisk.patch) });
    if (changed.length) this.sharedEmitter.fire({ from: e.id, cards: structuredClone(changed), back: back.length ? back : undefined });
    if (!prev || prev.outline !== outline(e.board) || prev.group !== e.group) this.changed.fire();
  }

  /**
   * 白板文件在这块白板上次读 / 写之后被另一个窗口改过：按项三方合并（mergeFile；base = 上次读到 / 写下的那份，
   * mine = 这边要写的，没给 = 这边没有改动，就是 base），合并后的样子换进缓存。
   * 返回合并后的文件、给开着的面板的改动、磁盘上的内容和 mtime；文件没被别人改过（mtime 或内容和上次一样）返回 undefined
   */
  private async mergeDisk(e: Entry, mine?: BoardFile): Promise<{ file: BoardFile; patch: BoardPatch | null; text: string; mtime: number } | undefined> {
    if (!e.file || !e.text) return undefined;
    let st: { mtimeMs: number };
    try { st = await this.fs.stat(e.file); } catch { return undefined; }
    if (st.mtimeMs === e.mtime) return undefined;
    let text: string, disk: BoardFile;
    try { text = await this.fs.readFile(e.file); disk = loadBoardFile(JSON.parse(text)); } catch { return undefined; }
    if (text === e.text) { e.mtime = st.mtimeMs; return undefined; }
    const base = loadBoardFile(JSON.parse(e.text));
    const both = mergeFile(base, disk, mine ?? base);
    for (const c of both.cards) if (c.kind === "shared") await this.readShared(c.id);
    const r = inflate(both, (id) => { const sc = this.lib.get(id)?.sc; return sc && structuredClone({ card: sc.card, sidenotes: sc.sidenotes }); });
    // 按项合并不管引用（那边删了卡、这边往它上面连了线）：按删卡的规矩带走悬空的
    pruneRefs(r.board);
    const file = deflate(r.board, new Set(r.refs)).file;
    const patch = diffBoards(e.board, r.board);
    e.board = r.board;
    e.refs = new Set(r.refs);
    for (const id of r.refs) { e.held.add(id); const sc = this.lib.get(id)?.sc; if (sc) e.used.set(id, sc); }
    this.opts.log?.("info", `storage: merged changes another window made to ${e.file}`);
    return { file, patch, text, mtime: st.mtimeMs };
  }

  /**
   * 另一个窗口写了这块白板的文件：合并进缓存（mergeDisk；这边没写盘的改动留着，到时照常写下去），
   * 开着的面板跟着换上（onDidMerge），侧栏、骨架、CodeLens 跟着刷新
   */
  private async pull(e: Entry) {
    const before = outline(e.board);
    const r = await this.mergeDisk(e, e.pending && deflate(e.board, e.refs).file);
    if (!r) return;
    e.text = r.text;
    e.mtime = r.mtime;
    this.saved.fire(e.board);
    if (r.patch) this.mergedEmitter.fire({ id: e.id, patch: structuredClone(r.patch) });
    if (before !== outline(e.board)) this.changed.fire();
  }

  /**
   * 卡库里的这张卡在外面（另一个窗口）改了：缓存里有它的白板换上（自己指着它的行号跟着挪了的稍后写盘），
   * 开着的面板跟着换（onDidShare，没有 from）。卡文件是这边写的（mtime 没变）时什么都不做
   */
  private async pullShared(id: string) {
    if (![...this.cache.values()].some((e) => e.refs.has(id))) return;
    const sc = await this.readShared(id);
    if (!sc) return;
    const items = new Set<string>();
    for (const e of this.cache.values()) {
      const was = e.used.get(id);
      if (!e.refs.has(id) || was === sc) continue;
      this.take(e, sc).forEach((k) => items.add(k));
    }
    if (items.size) this.sharedEmitter.fire({ cards: [{ ...structuredClone({ card: sc.card, sidenotes: sc.sidenotes }), items: [...items] }] });
  }

  /**
   * 卡库里这张卡的新一版放进缓存里的另一块白板：只换和它上次看到的那版（used）比变了的项。别的项可能是它还没写盘的改动
   * （WRITE_DELAY 里正等着写的正文、Sidenote），留着，到它写盘时照常和卡库合并。返回换了的项。
   * 它自己指着这张卡的行号跟着挪了（新版本）：那块白板也有了没写盘的改动，照常稍后写（写时和磁盘三方合并）
   */
  private take(o: Entry, sc: SharedCardFile): string[] {
    const id = sc.card.id;
    const items = itemsChanged(o.used.get(id), sc);
    const was = prevOf(o);
    if (items.length && applySharedUpdate(o.board, { card: sc.card, sidenotes: sc.sidenotes, items })) this.dirty(o, was);
    o.used.set(id, sc);
    return items;
  }

  // ---------- 卡库 ----------

  /** 缓存里的所有白板（只读，不扫描目录）：算共享卡在哪些白板上、谁连到它 */
  cached(): { id: string; board: Board; refs: ReadonlySet<string> }[] {
    return [...this.cache.values()].map((e) => ({ id: e.id, board: e.board, refs: e.refs }));
  }

  /** 拷出白板上的这些卡（Compare 带上两栏）：内容、摆放、跟着它们走的 Sidenote，和两端都在这些卡上的 Link。剪贴板、粘贴到别的白板用 */
  copyOut(id: string, cards: string[]): { cards: CardCopy[]; links: Link[] } {
    const b = this.cache.get(id)?.board;
    if (!b) return { cards: [], links: [] };
    const copies = structuredClone(cardCopies(b, cards));
    const want = new Set(copies.map((c) => c.card.id));
    return { cards: copies, links: structuredClone(b.links.filter((l) => want.has(l.from.card) && want.has(l.to.card))) };
  }

  /**
   * Delete Everywhere：把这张共享卡从所有白板上删掉（连着它的 Link、挂在上面的 Sidenote 一起，removeCards），卡库里的文件放进 .trash。
   * 返回删了它的白板；发 onDidRemoveShared，开着的白板跟着删
   */
  async deleteEverywhere(card: string, from?: string): Promise<string[]> {
    await this.scan();
    return this.serial(async () => {
      const out: string[] = [];
      for (const e of [...this.cache.values()]) {
        if (!e.refs.has(card) && !(e.id === from && e.board.cards.some((c) => c.id === card))) continue;
        const prev = prevOf(e);
        removeCards(e.board, [card]);
        e.refs.delete(card);
        e.held.delete(card);
        await this.commit(e, prev);
        out.push(e.id);
      }
      const file = this.fs.join(this.cardsDir(), `${card}.json`);
      if (SAFE_ID.test(card)) {
        const trash = this.fs.join(this.dir(), ".trash");
        await this.fs.mkdir(trash);
        await this.fs.rename(file, this.fs.join(trash, `card-${card}.${Date.now()}.json`)).catch(() => undefined);
      }
      this.lib.delete(card);
      this.removedEmitter.fire({ from, card, boards: out });
      return out;
    });
  }

  /** 这些共享卡要贴到白板 id 上（pasteClip）：白板存盘发来它们时算共享卡，不算新卡 */
  async offer(id: string, cards: string[]): Promise<void> {
    const e = await this.entry(id);
    for (const c of cards) e.held.add(c);
  }

  /** 白板上哪些卡是共享卡 */
  refsOf(id: string): ReadonlySet<string> { return this.cache.get(id)?.refs ?? new Set(); }

  /** 有这张共享卡的白板 */
  async boardsWith(card: string): Promise<string[]> {
    return (await this.scan()).filter((e) => e.refs.has(card)).map((e) => e.id);
  }

  /**
   * 把白板上的这些卡变成共享卡（Compare 带上它的两栏）：内容和跟着它走的 Sidenote 搬进卡库，白板文件里只留引用。
   * 卡库里已经有同 id 的卡（复制出来的白板上的同一张卡）时这块白板上的卡换个新 id；返回换了的 旧 id → 新 id
   */
  async share(id: string, cards: string[]): Promise<Record<string, string>> {
    return this.serial(async () => {
      const e = await this.entry(id);
      const want = withCols(e.board, cards);
      const prev = prevOf(e);
      const renamed: Record<string, string> = {};
      for (let c of want) {
        if (e.refs.has(c)) continue;
        if ((await this.readShared(c)) || [...this.cache.values()].some((o) => o.refs.has(c))) {
          const n = uid("c");
          renameCard(e.board, c, n);
          renamed[c] = n;
          c = n;
        }
        e.refs.add(c);
        e.held.add(c);
      }
      await this.commit(e, prev);
      return renamed;
    });
  }

  /** share() 会不会给这块白板上的卡换 id（卡库里已经有同 id 的卡，而这块白板上它还不是共享卡）。开着的白板不知道换了 id，粘贴时会换就改成拷贝 */
  async wouldRename(id: string, cards: string[]): Promise<boolean> {
    const e = await this.entry(id);
    for (const c of cards) if (!e.refs.has(c) && ((await this.readShared(c)) || [...this.cache.values()].some((o) => o.refs.has(c)))) return true;
    return false;
  }

  /**
   * 这块白板不再共享这张卡：留一份独立的拷贝（换一个新 id，edit.unlinkCard；跟着它的 Sidenote 也留下），别的白板和卡库里的不动。
   * 副本一定换 id（卡库和别的白板上的那张不能跟它同 id）。返回新 id；不是共享卡返回 null。开着这块白板的面板要重新载入
   */
  async unshare(id: string, card: string): Promise<string | null> {
    return this.serial(async () => {
      const e = await this.entry(id);
      if (!e.refs.has(card)) return null;
      for (const k of withCols(e.board, [card])) { e.refs.delete(k); e.held.delete(k); }
      const prev = prevOf(e);
      const to = unlinkCard(e.board, card);
      await this.commit(e, prev);
      return to;
    });
  }

  private async entry(id: string): Promise<Entry> {
    let e = this.cache.get(id);
    if (!e) { await this.scan(); e = this.cache.get(id); }
    if (!e) throw new Error(`Board ${id} not found.`);
    return e;
  }

  async create(name: string, group?: string): Promise<Board> {
    const b = emptyBoard(uid("b"), name);
    await this.save(b, { group: group ?? null });
    return b;
  }

  /** 删白板：放进 .trash，误删还能找回来。排在正在写的之后，没写的改动跟着扔掉（不然写盘又把它写回来） */
  async remove(id: string) {
    return this.serial(() => this.removeNow(id));
  }
  private async removeNow(id: string) {
    const fs = this.fs;
    const e = this.cache.get(id);
    if (!e) return;
    clearTimeout(this.timers.get(id));
    const trash = fs.join(this.dir(), ".trash");
    await fs.mkdir(trash);
    await fs.rename(e.file, fs.join(trash, `${id}.${Date.now()}.json`)).catch(() => fs.rm(e.file));
    this.cache.delete(id);
    this.changed.fire();
    this.removedBoard.fire(id);
  }

  /**
   * 撤销 Turn into Board：拆出来的白板还是刚建好时的样子 made（镜头不算）才放进 .trash，返回 true。
   * 建好以后又改过（进去编辑过）就留着、返回 false：撤销不能把用户的改动一起扔掉（父白板照样撤回去，这块白板留在列表里）
   */
  async dropIfUnchanged(id: string, made: Board): Promise<boolean> {
    return this.serial(async () => {
      if (!this.cache.has(id)) await this.scan();
      const e = this.cache.get(id);
      if (!e || boardKey(e.board) !== boardKey(made)) return false;
      await this.removeNow(id);
      return true;
    });
  }

  /** 重做 Turn into Board：.trash 里这块白板最近放进去的那份放回来（放进组 group；没有 = 顶层）。.trash 里没有返回 false */
  async restore(id: string, group?: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    return this.serial(async () => {
      const fs = this.fs, trash = fs.join(this.dir(), ".trash");
      const re = new RegExp(`^${id}\\.(\\d+)\\.json$`);
      const names = (await fs.readdir(trash).catch(() => [])).map((d) => re.exec(d.name)).filter((m): m is RegExpExecArray => !!m);
      if (!names.length || this.cache.has(id)) return false;
      const last = names.sort((a, b) => Number(b[1]) - Number(a[1]))[0][0];
      const dir = group ? fs.join(this.dir(), group) : this.dir();
      await fs.mkdir(dir);
      await fs.rename(fs.join(trash, last), fs.join(dir, `${id}.json`));
      await this.scan();
      this.changed.fire();
      return true;
    });
  }

  /**
   * 读-改-写一块白板，排在写盘队列里（中间来的 patch 不会被一份旧拷贝盖掉）：fn 直接改缓存里的那份，返回 false = 不用改。
   * group：同时换组（null = 顶层）。返回改完的白板（拷贝）；没有这块白板或没改返回 null
   */
  async update(id: string, fn: (b: Board) => boolean | void, o: { group?: string | null } = {}): Promise<Board | null> {
    return this.serial(async () => {
      let e = this.cache.get(id);
      if (!e) { await this.scan(); e = this.cache.get(id); }
      if (!e) return null;
      const prev = prevOf(e);
      if (fn(e.board) === false) return null;
      if (o.group !== undefined) e.group = o.group ?? undefined;
      const ids = new Set(e.board.cards.map((c) => c.id));
      for (const r of [...e.refs]) if (!ids.has(r)) e.refs.delete(r);
      await this.commit(e, prev);
      return structuredClone(e.board);
    });
  }

  async rename(id: string, name: string) {
    await this.update(id, (b) => { b.name = name; });
  }

  async duplicate(id: string): Promise<Board | null> {
    const b = await this.load(id);
    if (!b) return null;
    const nb: Board = { ...structuredClone(b), id: uid("b"), name: `${b.name} copy` };
    // 本白板自己的卡换新 id：副本上的卡和原来的是两张卡（以后原来的那张变成共享卡时，副本上的不会被认成它）；共享卡还是同一张
    const refs = this.cache.get(id)?.refs ?? new Set<string>();
    for (const c of [...nb.cards]) if (!refs.has(c.id)) renameCard(nb, c.id, uid("c"));
    await this.save(nb, { group: this.cache.get(id)?.group ?? null, refs });
    return nb;
  }

  async move(id: string, group: string | undefined) {
    const g = group === undefined ? null : groupName(group);
    if (group !== undefined && !g) return;
    await this.update(id, () => {}, { group: g });
  }

  groupOf(id: string) { return this.cache.get(id)?.group; }
  fileOf(id: string) { return this.cache.get(id)?.file; }

  async newGroup(name: string) {
    const safe = groupName(name);
    if (!safe) return;
    await this.fs.mkdir(this.fs.join(this.dir(), safe));
    this.emptyGroups.add(safe);
    this.changed.fire();
  }

  /** 组改名 = 文件夹改名：排在正在写的之后，没写的改动先写进原来的文件夹 */
  async renameGroup(from: string, to: string) {
    const safe = groupName(to);
    if (!safe || !groupName(from)) return;
    return this.serial(async () => {
      await this.writePending();
      await this.fs.rename(this.fs.join(this.dir(), from), this.fs.join(this.dir(), safe));
      this.emptyGroups.delete(from);
      this.cache.clear();
      this.changed.fire();
    });
  }

  /**
   * 删组：白板移回顶层，再删空了的文件夹。文件夹里还有别的东西（读不了的白板、不是白板的文件）时不删、不动它们，
   * 文件夹留着（还是一个组）；返回留下的文件名
   */
  async removeGroup(name: string): Promise<string[]> {
    if (!groupName(name)) return []; // ".." 之类会跑到存储目录外面去
    for (const e of await this.scan()) if (e.group === name) await this.move(e.id, undefined);
    const dir = this.fs.join(this.dir(), name);
    const left = (await this.fs.readdir(dir).catch(() => [])).map((d) => d.name);
    if (!left.length) {
      await this.fs.rmdir(dir).catch(() => undefined); // 已经没有这个文件夹了
      this.emptyGroups.delete(name);
    }
    this.changed.fire();
    return left;
  }

  /** 设置里换了目录：没写的改动先写回原来的文件 */
  reset(): Promise<void> {
    return this.serial(async () => {
      await this.writePending();
      this.cache.clear(); this.lib.clear(); this.emptyGroups.clear();
      this.watchDir();
      this.changed.fire();
    });
  }

  fireChanged() { this.changed.fire(); }

  /** 存一张图片到 assets/，按内容去重；返回文件名 */
  async saveAsset(name: string, dataUrl: string): Promise<string> {
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) throw new Error("Not an image");
    const buf = this.fs.fromBase64(m[2]);
    const ext = extName(name) || `.${(m[1].split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg")}`;
    const file = `${this.fs.sha1(buf).slice(0, 16)}${ext.toLowerCase()}`;
    await this.fs.mkdir(this.assetsDir());
    await this.fs.writeFile(this.fs.join(this.assetsDir(), file), buf);
    return file;
  }
}

/**
 * 白板上的一张共享卡（view）按项（卡、每条 Sidenote）合并进卡库里的那份（disk）。base = 这块白板上次读到 / 写下的那份：
 * 和 base 比变了的项是这块白板改的，用它的；没改的项用磁盘上的（另一个窗口可能改过、加过）；base 里有、view 里没有的项是这块白板删的。
 * 没有 base（这块白板第一次存这张卡，比如刚贴过来）：它的项都算它改的，但不删任何项。
 * 返回要写的文件（和磁盘上一样时 null）、这块白板改了的项（mine）、和磁盘上比变了的项（items，发给别的白板）、和 view 比变了的项（back，这块白板自己要换上）。
 * Sidenote 的先后不算（每块白板上可能不一样）
 */
export function merged(base: SharedCard | undefined, disk: SharedCard | undefined, view: SharedCard): { file: SharedCardFile | null; mine: string[]; items: string[]; back: string[] } {
  const c = mergeById(base && [base.card], disk ? [disk.card] : [], [view.card]);
  const n = mergeById(base?.sidenotes, disk?.sidenotes ?? [], view.sidenotes);
  const now: SharedCard = { card: c.items[0] ?? view.card, sidenotes: n.items };
  const items = itemsChanged(disk, now);
  const file: SharedCardFile | null = items.length || !disk ? structuredClone({ version: BOARD_VERSION, ...now }) : null;
  return { file, mine: [...c.changed, ...n.changed], items: [...new Set([...items, ...itemsChanged(base, now)])], back: itemsChanged(view, now) };
}

/** 共享卡从 x 到 y 变了的项（卡 id、Sidenote 的 id：改了、加了、删了的）；Sidenote 的先后不算 */
function itemsChanged(x: SharedCard | undefined, y: SharedCard): string[] {
  const xs = new Map((x?.sidenotes ?? []).map((n) => [n.id, n]));
  const d = same(x?.card, y.card) ? [] : [y.card.id];
  for (const n of y.sidenotes) { if (!same(xs.get(n.id), n)) d.push(n.id); xs.delete(n.id); }
  return [...d, ...xs.keys()];
}

/** 比较两份白板内容用的键：镜头和版本不算，字段先后不算 */
const boardKey = (b: Board) => JSON.stringify({ ...b, cam: undefined, version: undefined }, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/** 侧栏关心的部分：名字、卡片数、子白板 */
const outline = (b: Board) => JSON.stringify([b.name, b.cards.length, allCodeCards(b).length, subBoardsOf(b)]);
/** 改之前的样子：有没写盘的改动时是第一次改之前的 */
const prevOf = (e: Entry): Prev => e.pending ?? { file: e.file, outline: outline(e.board), group: e.group };
