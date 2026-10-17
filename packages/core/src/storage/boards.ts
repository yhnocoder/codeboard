// 白板存储（第 2 版起的目录结构）：一张白板一个 JSON，组 = 子文件夹（只有一层），图片放 assets/，删掉的放 .trash/。
// 目录在哪由宿主决定（dir()）；读写都经过 Fs 适配器。旧版本的白板文件读进来时迁移，下次保存写成当前版本。
// 第 6 版起还是卡库（Library）：共享卡放 cards/<id>.json，白板文件里只留引用。这里缓存的、交出去的都是换上了内容的完整白板；
// 写盘时再拆开（deflate），共享卡变了的项 rev +1、写卡文件，再通知开着同一张卡的别的白板（onDidShare）。
import { allCodeCards, BOARD_VERSION, emptyBoard, uid, type Board, type BoardMeta, type SharedCard, type SharedCardFile } from "../model";
import { Emitter } from "../emitter";
import { loadBoardFile, loadSharedCard } from "../schema";
import { applyPatch, deflate, inflate, putShared, sharedOf, travels, type BoardPatch, type SharedUpdate } from "../patch";
import { removeCards, renameCard, unlinkCard, type CardCopy } from "../edit";
import { subBoardsOf } from "../subboard";
import { baseName, extName, type Fs } from "./fs";

/** refs = 这块白板上的共享卡；used = 换进来的是卡库里的哪一版（卡文件在外面被改了时重新换） */
type Entry = { id: string; file: string; group?: string; mtime: number; birth: number; board: Board; refs: Set<string>; used: Map<string, SharedCardFile> };
/** 一次写盘改了的共享卡（from = 哪块白板改的；别的开着这张卡的白板要跟着换） */
export type SharedChange = { from: string; cards: SharedUpdate[] };

export type StorageOpts = {
  /** 存储目录（设置可能变，每次用时问） */
  dir: () => string;
  log?: (level: "info" | "warn" | "error", text: string) => void;
};

export const RESERVED = new Set(["assets", "github", "cards", "runs", ".trash"]);
/** 组名就是子文件夹名：去掉路径符号；"."、".." 和点开头的（.trash）、保留名都不行 */
export function groupName(name: string): string | null {
  const safe = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return safe && !safe.startsWith(".") && !RESERVED.has(safe) ? safe : null;
}
/** 白板 id 也是文件名：只允许字母、数字、- 和 _ */
export const SAFE_ID = /^[\w-]{1,80}$/;

export const boardUid = (p = "b") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export class Storage {
  private changed = new Emitter<void>();
  /** 白板列表变了（增删、改名、分组、卡片数） */
  readonly onDidChange = this.changed.event;
  private saved = new Emitter<Board>();
  /** 任何一次保存（CodeLens、行号旁标记要跟着变） */
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
  /** 卡库的缓存（按修改时间） */
  private lib = new Map<string, { mtime: number; sc: SharedCardFile }>();
  /** 共享的每一项（卡、Sidenote）最后是哪块白板写的：撤销时别的白板后来改过的项不撤（只在内存里，重启后撤销栈也没了） */
  private writer = new Map<string, string>();
  /** 写盘排队：两块白板同时保存时，卡文件的 rev 不会算乱 */
  private q: Promise<unknown> = Promise.resolve();

  constructor(private fs: Fs, private opts: StorageOpts) {}

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
        if (!e || e.mtime !== st.mtimeMs) {
          const raw = JSON.parse(await fs.readFile(f.file));
          const board = loadBoardFile(raw);
          // id 决定存盘的文件名：只认安全的 id；和别的文件重了（Finder 里复制出来的）就换一个新的，免得两份互相覆盖
          const base = idOf(f.file);
          if (!SAFE_ID.test(board.id ?? "")) board.id = SAFE_ID.test(base) ? base : boardUid();
          else if (board.id !== base && files.some((g) => idOf(g.file) === board.id)) board.id = boardUid();
          if (seen.has(board.id)) board.id = boardUid();
          board.sidenotes ??= [];
          board.sections ??= [];
          board.links ??= [];
          // 共享卡：引用换成卡库里的内容
          const used = new Map<string, SharedCardFile>();
          for (const c of board.cards) if (c.kind === "shared") { const sc = await this.readShared(c.id); if (sc) used.set(c.id, sc); }
          const r = inflate(board, (id) => { const sc = used.get(id); return sc && structuredClone({ card: sc.card, sidenotes: sc.sidenotes }); });
          if (r.missing.length) this.opts.log?.("warn", `storage: board ${f.file} refers to missing shared cards ${r.missing.join(", ")}`);
          e = { id: board.id, file: f.file, group: f.group, mtime: st.mtimeMs, birth: st.birthtimeMs || st.ctimeMs, board: r.board, refs: new Set(r.refs), used };
          this.cache.set(board.id, e);
        } else {
          // 白板文件没变，卡库里的卡可能在外面改了
          for (const id of e.refs) {
            const sc = await this.readShared(id);
            if (sc && sc !== e.used.get(id)) { putShared(e.board, structuredClone({ card: sc.card, sidenotes: sc.sidenotes })); e.used.set(id, sc); }
          }
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
      const e: Entry = { id: b.id, file: old?.file ?? "", group, mtime: 0, birth: old?.birth ?? Date.now(), board, refs, used: new Map(old?.used) };
      await this.commit(e, old && { file: old.file, outline: outline(old.board), group: old.group });
    });
  }

  /**
   * 白板发来的增量改动（BoardPatch）：改缓存里的那份、写盘。返回要还给这块白板的共享卡（undo 时跳过了的项：别的白板后来改过，
   * 宿主这边留着别人的版本，白板要换回来）
   */
  async patch(id: string, p: BoardPatch, o: { undo?: boolean } = {}): Promise<SharedUpdate[]> {
    return this.serial(async () => {
      let e = this.cache.get(id);
      if (!e) { await this.scan(); e = this.cache.get(id); }
      if (!e) throw new Error(`Board ${id} not found.`);
      const prev = { file: e.file, outline: outline(e.board), group: e.group };
      const skipped = o.undo && !p.full ? this.dropStale(e, p) : new Map<string, string[]>();
      applyPatch(e.board, p);
      const ids = new Set(e.board.cards.map((c) => c.id));
      for (const r of [...e.refs]) if (!ids.has(r)) e.refs.delete(r); // Remove from Board：卡库里的卡不动
      // 卡库里有的 id 就是共享卡：粘贴过来的共享卡、撤销 Remove from Board 回来的卡（独立副本都换过 id，见 edit.unlinkCard）
      for (const c of p.cards?.set ?? []) if (!e.refs.has(c.id) && (await this.readShared(c.id))) e.refs.add(c.id);
      await this.commit(e, prev);
      const out: SharedUpdate[] = [];
      for (const [c, items] of skipped) { const sc = sharedOf(e.board, c); if (sc) out.push({ ...structuredClone(sc), items }); }
      return out;
    });
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
   * 写盘：共享卡和卡库里的比，变了的项 rev +1、写卡文件（先写卡，再写白板文件），别的白板缓存里的同一张卡跟着换，发 onDidShare。
   * prev = 写之前的样子（文件在哪、侧栏关心的部分、组）；新白板没有
   */
  private async commit(e: Entry, prev?: { file: string; outline: string; group?: string }) {
    const fs = this.fs;
    const { file: data, shared } = deflate(e.board, e.refs);
    const changed: SharedUpdate[] = [];
    for (const sc of shared) {
      const items: string[] = [];
      const next = bumped(await this.readShared(sc.card.id), sc, (item) => { this.writer.set(item, e.id); items.push(item); });
      if (!next) continue;
      await this.writeShared(next);
      e.used.set(sc.card.id, next);
      changed.push({ card: next.card, sidenotes: next.sidenotes, items });
    }
    const dir = e.group ? fs.join(this.dir(), e.group) : this.dir();
    await fs.mkdir(dir);
    const file = fs.join(dir, `${e.id}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, file);
    if (prev?.file && prev.file !== file) await fs.rm(prev.file);
    e.file = file;
    e.mtime = (await fs.stat(file)).mtimeMs;
    this.cache.set(e.id, e);
    const moved = new Set<Entry>();
    for (const sc of changed) {
      const id = sc.card.id;
      for (const o of this.cache.values()) {
        if (o === e || !o.refs.has(id)) continue;
        const r: { moved?: boolean } = {};
        putShared(o.board, structuredClone({ card: sc.card, sidenotes: sc.sidenotes }), r);
        o.used.set(id, this.lib.get(id)!.sc);
        if (r.moved) moved.add(o);
      }
    }
    // 别的白板自己指着这张卡的行号跟着挪了（新版本）：那块白板的文件也要写
    for (const o of moved) await this.writeBoard(o);
    this.saved.fire(e.board);
    if (changed.length) this.sharedEmitter.fire({ from: e.id, cards: structuredClone(changed) });
    if (!prev || prev.outline !== outline(e.board) || prev.group !== e.group) this.changed.fire();
  }

  /** 只写白板文件（卡库不动）：别的白板改了共享卡、这块白板跟着挪了行号时 */
  private async writeBoard(e: Entry) {
    const fs = this.fs;
    const { file: data } = deflate(e.board, e.refs);
    const tmp = `${e.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, e.file);
    e.mtime = (await fs.stat(e.file)).mtimeMs;
  }

  // ---------- 卡库 ----------

  /** 缓存里的所有白板（只读，不扫描目录）：算共享卡在哪些白板上、谁连到它 */
  cached(): { id: string; board: Board; refs: ReadonlySet<string> }[] {
    return [...this.cache.values()].map((e) => ({ id: e.id, board: e.board, refs: e.refs }));
  }

  /** 拷出白板上的这些卡（Compare 带上两栏）：内容、摆放、跟着它们走的 Sidenote。剪贴板、粘贴到别的白板用 */
  copyOut(id: string, cards: string[]): CardCopy[] {
    const b = this.cache.get(id)?.board;
    if (!b) return [];
    const want = new Set<string>();
    for (const c of cards) {
      const card = b.cards.find((k) => k.id === c);
      if (!card) continue;
      if (card.kind === "compare") card.cols.forEach((k) => want.add(k));
      want.add(c);
    }
    return b.cards.filter((c) => want.has(c.id)).map((c) => structuredClone({ card: c, place: b.place[c.id], sidenotes: b.sidenotes.filter((n) => travels(n, c.id)) }));
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
        const prev = { file: e.file, outline: outline(e.board), group: e.group };
        removeCards(e.board, [card]);
        e.refs.delete(card);
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
      const want = new Set<string>();
      for (const c of cards) {
        const card = e.board.cards.find((k) => k.id === c);
        if (!card) continue;
        want.add(c);
        if (card.kind === "compare") card.cols.forEach((k) => want.add(k));
      }
      const prev = { file: e.file, outline: outline(e.board), group: e.group };
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
   * 卡库里有的 id 一律当共享卡（见 patch），所以副本一定换 id。返回新 id；不是共享卡返回 null。开着这块白板的面板要重新载入
   */
  async unshare(id: string, card: string): Promise<string | null> {
    return this.serial(async () => {
      const e = await this.entry(id);
      if (!e.refs.has(card)) return null;
      const c = e.board.cards.find((k) => k.id === card);
      e.refs.delete(card);
      if (c?.kind === "compare") c.cols.forEach((k) => e.refs.delete(k));
      const prev = { file: e.file, outline: outline(e.board), group: e.group };
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
    const b = emptyBoard(boardUid(), name);
    await this.save(b, { group: group ?? null });
    return b;
  }

  async remove(id: string) {
    const fs = this.fs;
    const e = this.cache.get(id);
    if (!e) return;
    // 放进 .trash，误删还能找回来
    const trash = fs.join(this.dir(), ".trash");
    await fs.mkdir(trash);
    await fs.rename(e.file, fs.join(trash, `${id}.${Date.now()}.json`)).catch(() => fs.rm(e.file));
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
    const nb: Board = { ...structuredClone(b), id: boardUid(), name: `${b.name} copy` };
    await this.save(nb, { group: this.cache.get(id)?.group ?? null, refs: this.cache.get(id)?.refs });
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
    await this.fs.mkdir(this.fs.join(this.dir(), safe));
    this.emptyGroups.add(safe);
    this.changed.fire();
  }

  async renameGroup(from: string, to: string) {
    const safe = groupName(to);
    if (!safe || !groupName(from)) return;
    await this.fs.rename(this.fs.join(this.dir(), from), this.fs.join(this.dir(), safe));
    this.emptyGroups.delete(from);
    this.cache.clear();
    this.changed.fire();
  }

  /** 删组：白板移回顶层，再删文件夹 */
  async removeGroup(name: string) {
    if (!groupName(name)) return; // ".." 之类会删到存储目录外面去
    for (const e of await this.scan()) if (e.group === name) await this.move(e.id, undefined);
    await this.fs.rm(this.fs.join(this.dir(), name));
    this.emptyGroups.delete(name);
    this.changed.fire();
  }

  /** 设置里换了目录 */
  reset() { this.cache.clear(); this.lib.clear(); this.emptyGroups.clear(); this.changed.fire(); }

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
 * 白板上的一张共享卡和卡库里的比：变了的项（卡、每条 Sidenote）rev +1，touch 记下是谁写的；什么都没变返回 null。
 * Sidenote 的先后不算（每块白板上可能不一样）
 */
function bumped(prev: SharedCardFile | undefined, sc: SharedCard, touch: (item: string) => void): SharedCardFile | null {
  const rev = { ...(prev?.rev ?? {}) };
  let dirty = !prev;
  const same = (a: unknown, b: unknown) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
  const bump = (item: string) => { rev[item] = (rev[item] ?? 0) + 1; touch(item); dirty = true; };
  if (!same(prev?.card, sc.card)) bump(sc.card.id);
  const old = new Map((prev?.sidenotes ?? []).map((n) => [n.id, n]));
  for (const n of sc.sidenotes) { if (!same(old.get(n.id), n)) bump(n.id); old.delete(n.id); }
  for (const item of old.keys()) { delete rev[item]; touch(item); dirty = true; }
  return dirty ? structuredClone({ version: BOARD_VERSION, card: sc.card, sidenotes: sc.sidenotes, rev }) : null;
}

/** 侧栏关心的部分：名字、卡片数、子白板 */
const outline = (b: Board) => JSON.stringify([b.name, b.cards.length, allCodeCards(b).length, subBoardsOf(b)]);
