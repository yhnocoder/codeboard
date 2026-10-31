import { Emitter, boardRefsOf, cutCrumbs, diffBoards, sharedInfo, skeletonOf, subBoardsOf, type AskType, type BoardRef, type BoardRefs, type RecentRef, type BoardMeta, type BoardPatch, type BoardToHost, type Camera, type Crumb, type Disposable, type HostToBoard, type ReplyOf, type Segment, type Skeleton, type WalkHop } from "@codeboard/core";
import type { CardClip, Storage } from "@codeboard/core/storage";
import { BoardPanel, type BoardHost, type BoardView } from "./boards";
import type { HostEnv, ViewPlace } from "./env";
import type { Handler } from "./handlers";
import { log } from "./log";
import { viewsFor } from "./views";
import { variantSegments } from "./versions";
import { workspace } from "./ws";

const TARGET = "codeboard.target", OPEN = "codeboard.open", OPENED = "codeboard.opened", ADDED = "codeboard.added", REF_RECENT = "codeboard.refRecent";

export class BoardHub implements BoardHost, Disposable {
  private panels = new Map<string, BoardPanel>();
  target: string | undefined;
  private targetEmitter = new Emitter<void>();
  readonly onDidChangeTarget = this.targetEmitter.event;
  private staleEmitter = new Emitter<void>();
  readonly onDidChangeStale = this.staleEmitter.event;
  handler: Handler = async () => undefined;
  /** ⌘C 复制的卡（贴到别的白板时用） */
  clip: CardClip | undefined;
  /** 共享卡的改动按顺序转发（段的展示数据要先算好） */
  private shareQ: Promise<unknown> = Promise.resolve();
  private subs: Disposable[] = [];

  constructor(private env: HostEnv, readonly store: Storage) {
    this.target = workspace().storage.get<string>(TARGET);
    // 共享卡写进了卡库：开着同一张卡的别的白板换上（存储里的那份已经换好了）。卡本身变了（新版本、改段）时带上段的展示数据
    this.subs.push(store.onDidShare((e) => {
      this.shareQ = this.shareQ.then(async () => {
        for (const p of this.all()) {
          // 写的那块白板只换上 back（卡文件被另一个窗口改过，合并进来的项）
          const from = p.id === e.from;
          if (from && !e.back) continue;
          const refs = store.refsOf(p.id);
          const cards = (from ? e.back! : e.cards).filter((sc) => refs.has(sc.card.id));
          if (!cards.length) continue;
          // Variant 的段（不在显示的）也要展示数据：切换时直接换上
          const segs: Segment[] = cards.flatMap((sc) => (sc.items.includes(sc.card.id) && sc.card.kind === "code" ? [...sc.card.segments, ...variantSegments({ cards: [sc.card] })] : []));
          const views = segs.length ? await viewsFor(segs) : undefined;
          p.board = store.peek(p.id);
          p.post({ type: "shared", cards, views });
          if (segs.length) void p.refreshStale();
        }
      }).catch((err) => log("error", `shared: ${err instanceof Error ? err.message : err}`));
    }));
    // 写盘时合并进了另一个窗口的改动：开着这块白板的面板跟着换上（新来的代码卡带上段的展示数据）
    this.subs.push(store.onDidMerge((e) => {
      this.shareQ = this.shareQ.then(async () => {
        const p = this.get(e.id);
        if (p) await this.postMerged(p, e.patch);
      }).catch((err) => log("error", `merged: ${err instanceof Error ? err.message : err}`));
    }));
    // Delete Everywhere：开着的别的白板跟着删
    this.subs.push(store.onDidRemoveShared((e) => {
      for (const p of this.all()) {
        if (p.id === e.from || !e.boards.includes(p.id)) continue;
        p.board = store.peek(p.id);
        p.post({ type: "sharedGone", cards: [e.card] });
      }
    }));
    // 删掉的白板在面包屑上：那几层回不去了，剪掉
    this.subs.push(store.onDidRemoveBoard((id) => {
      for (const p of this.all()) {
        const c = cutCrumbs(p.crumbs, p.cams, id);
        if (!c) continue;
        p.crumbs = c.crumbs; p.cams = c.cams;
        p.post({ type: "crumbs", crumbs: c.crumbs });
      }
    }));
    // 白板的改动写不下去：存储过一会儿自己重试，开着它的面板说一声
    this.subs.push(store.onDidFailSave((e) => this.panels.get(e.board)?.toast(`Couldn't save the board: ${e.error}. Retrying…`)));
    this.subs.push(store.onDidRecoverSave((id) => this.panels.get(id)?.toast("The board is saved again.")));
    // 共享卡的「⧉ N boards」「← N」：任何白板存盘、改名后重算（只发变了的面板）
    this.subs.push(store.onDidSave(() => this.refreshShared()), store.onDidChange(() => this.refreshShared()));
    // 子白板的骨架：子白板存盘后重算（只算存了的那块），白板列表变了（改名、删白板）全部重算；都防抖
    this.subs.push(store.onDidSave((b) => { this.dirtySkels.add(b.id); this.refreshSkeletons(); }), store.onDidChange(() => { this.allSkels = true; this.refreshSkeletons(); }));
    // [[ 引用能选的别的白板上的卡：存了盘的那块重算，白板列表变了（改名、增删）全部重算；都防抖
    this.subs.push(store.onDidSave((b) => { this.refsOf.delete(b.id); this.refreshBoardRefs(); }), store.onDidChange(() => { this.refsOf.clear(); this.refreshBoardRefs(); }));
  }

  /** 面板换上宿主这边变了的白板（patch = 从它现在的样子到存储里的样子）；新来的代码卡带上段的展示数据 */
  private async postMerged(p: BoardPanel, patch: BoardPatch) {
    const segs = (patch.cards?.set ?? []).flatMap((c) => (c.kind === "code" ? [...c.segments, ...variantSegments({ cards: [c] })] : []));
    const views = segs.length ? await viewsFor(segs) : undefined;
    p.board = this.store.peek(p.id);
    p.post({ type: "merged", patch, views });
  }

  /**
   * 存储目录换了（.codeboard/ 出现或没了、设置改了、Move Boards into Project）：开着的白板新目录里没有的关掉（和删了一样），
   * 有但内容不一样的（另一个分支上的那份）换上，和别的窗口改了文件时一样
   */
  async followStorage() {
    await (this.shareQ = this.shareQ.then(async () => {
      for (const p of this.all()) {
        const b = await this.store.load(p.id);
        if (!b) { p.view.dispose(); if (this.target === p.id) this.setTarget(undefined); continue; }
        const patch = p.board && diffBoards(p.board, b);
        if (patch) await this.postMerged(p, patch);
        else p.board = this.store.peek(p.id);
      }
    }).catch((err) => log("error", `storage switch: ${err instanceof Error ? err.message : err}`)));
    await this.pushBoards();
  }

  dispose() {
    for (const d of this.subs) d.dispose();
    clearTimeout(this.skelT);
    clearTimeout(this.sharedT);
    clearTimeout(this.refsT);
    this.targetEmitter.dispose();
    this.staleEmitter.dispose();
  }

  private skelT: ReturnType<typeof setTimeout> | undefined;
  /** 每个面板发过的骨架（子白板 id → JSON） */
  private skelSent = new Map<BoardPanel, Map<string, string>>();
  private dirtySkels = new Set<string>();
  private allSkels = false;
  skeleton(id: string): Skeleton | null {
    const b = this.store.peek(id);
    return b ? skeletonOf(b, (x) => this.store.peek(x)) : null;
  }
  /**
   * 子白板的骨架推给开着的白板：每个面板只发它上面的子白板里变了的（还没发过的、存过盘的、白板列表变了时全部比一遍）。
   * 跟共享卡的情况一样防抖 120ms；fresh = 刚 init 的面板（之前发的不算）
   */
  refreshSkeletons(now = false, fresh?: string) {
    if (fresh) { const p = this.panels.get(fresh); if (p) this.skelSent.delete(p); }
    clearTimeout(this.skelT);
    const run = () => {
      const dirty = this.dirtySkels, all = this.allSkels;
      this.dirtySkels = new Set();
      this.allSkels = false;
      const memo = new Map<string, Skeleton | null>();
      const sk = (id: string) => { if (!memo.has(id)) memo.set(id, this.skeleton(id)); return memo.get(id)!; };
      // 骨架里有一路往下的子白板上能 [[ 链接的卡：下面哪一层存了盘，这块的骨架也要重算
      const touched = (id: string, seen = new Set<string>()): boolean => {
        if (dirty.has(id)) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        const b = this.store.peek(id);
        return !!b && subBoardsOf(b).some((x) => touched(x, seen));
      };
      for (const p of this.all()) {
        const b = this.store.peek(p.id);
        if (!p.ready || !b) continue;
        let sent = this.skelSent.get(p);
        if (!sent) this.skelSent.set(p, (sent = new Map()));
        const out: Record<string, Skeleton | null> = {};
        for (const id of subBoardsOf(b)) {
          if (sent.has(id) && !all && !touched(id)) continue;
          const s = sk(id), k = JSON.stringify(s);
          if (sent.get(id) === k) continue;
          sent.set(id, k);
          out[id] = s;
        }
        if (Object.keys(out).length) p.post({ type: "skeletons", boards: out });
      }
    };
    if (now) run(); else this.skelT = setTimeout(run, 120);
  }

  private refsT: ReturnType<typeof setTimeout> | undefined;
  /** 要过 boardRefs 的面板 → 上次发给它的（JSON） */
  private refsSent = new Map<BoardPanel, string>();
  /** 每块白板上能 [[ 链接的卡（存盘时作废那一块）：别的白板一存盘就要给每个面板重排一遍，不每次都把所有白板的卡走一遍 */
  private refsOf = new Map<string, BoardRef[]>();
  /** 面板 p 的 [[ 能选的别的白板（除了它显示的这块）：最近打开的在前，没打开过的按建的先后；和这个工作区最近选过的引用 */
  boardRefs(p: BoardPanel): BoardRefs {
    if (!this.refsSent.has(p)) this.refsSent.set(p, "");
    const all = this.store.cached().filter((e) => e.id !== p.id);
    const nameOf = (id: string) => this.store.peek(id)?.name;
    const seen = new Map(all.map((e, i) => [e.id, [this.lastOpened(e.id) ?? 0, i]]));
    all.sort((a, b) => seen.get(b.id)![0] - seen.get(a.id)![0] || seen.get(a.id)![1] - seen.get(b.id)![1]);
    const boards = all.map((e) => {
      let refs = this.refsOf.get(e.id);
      if (!refs) this.refsOf.set(e.id, (refs = boardRefsOf(e.board, nameOf)));
      return { id: e.id, name: e.board.name, refs };
    });
    return { boards, recent: workspace().storage.get<RecentRef[]>(REF_RECENT) ?? [] };
  }
  /** 要过 boardRefs 的面板里变了的重推（防抖 120ms）；fresh = 刚 init 的面板（换了白板，之前发的不算） */
  refreshBoardRefs(now = false, fresh?: string) {
    if (fresh) for (const p of this.refsSent.keys()) if (p.id === fresh) this.refsSent.set(p, "");
    clearTimeout(this.refsT);
    const run = () => {
      for (const [p, was] of this.refsSent) {
        if (!p.ready) continue;
        const refs = this.boardRefs(p), k = JSON.stringify(refs);
        if (k === was) continue;
        this.refsSent.set(p, k);
        p.post({ type: "boardRefs", refs });
      }
    };
    if (now) run(); else this.refsT = setTimeout(run, 120);
  }
  /** [[ 引用选了一项：记进最近选过的（新的在前，最多 3 个），要过的面板跟着更新 */
  refPicked(b: string, id: string) {
    const was = workspace().storage.get<RecentRef[]>(REF_RECENT) ?? [];
    void workspace().storage.set(REF_RECENT, [{ b, id }, ...was.filter((r) => r.b !== b || r.id !== id)].slice(0, 3));
    this.refreshBoardRefs();
  }

  get globalState() { return this.env.globalState; }

  /** 上次打开的时间（跨工作区；「回来接上」的提示用） */
  lastOpened(id: string): number | undefined { return this.env.globalState.get<Record<string, number>>(OPENED)?.[id]; }
  opened(id: string) {
    const m = { ...(this.env.globalState.get<Record<string, number>>(OPENED) ?? {}), [id]: Date.now() };
    void this.env.globalState.set(OPENED, m);
  }

  firstAdd(): boolean {
    if (workspace().storage.get<boolean>(ADDED)) return false;
    void workspace().storage.set(ADDED, true);
    return true;
  }

  /**
   * 面板换一块白板显示（进入子白板、从面包屑回去）：白板那边已经存好了（发消息前 flush 过）。
   * 子白板已经在别的面板里开着时切到那个面板（同一块白板不开两份），返回 false
   */
  async switchBoard(p: BoardPanel, to: string, o: { crumbs: Crumb[]; cams: Camera[]; walk?: WalkHop; cam?: Camera }): Promise<boolean> {
    const other = this.panels.get(to);
    if (other && other !== p) { other.view.reveal(); return false; }
    const b = await this.store.load(to);
    if (!b) throw new Error("Board not found.");
    const was = p.id;
    this.panels.delete(was);
    p.id = to;
    this.panels.set(to, p);
    p.crumbs = o.crumbs;
    p.cams = o.cams;
    p.next = { walk: o.walk, cam: o.cam };
    p.ready = false;
    this.skelSent.delete(p);
    this.sharedSent.delete(was);
    if (this.refsSent.has(p)) this.refsSent.set(p, "");
    this.saveOpen();
    if (this.target === was) this.setTarget(to);
    await p.init(b);
    return true;
  }

  private sharedT: ReturnType<typeof setTimeout> | undefined;
  private sharedSent = new Map<string, string>();
  /** 共享卡的情况推给开着的白板（防抖，宿主这边算；白板只在收到时更新卡头）。fresh = 刚 init 的白板（之前发过的不算） */
  refreshShared(now = false, fresh?: string) {
    if (fresh) this.sharedSent.delete(fresh);
    clearTimeout(this.sharedT);
    const run = () => {
      const all = this.store.cached();
      for (const p of this.all()) {
        if (!p.ready) continue;
        const cards = sharedInfo(all, p.id);
        const key = JSON.stringify(cards);
        if (this.sharedSent.get(p.id) === key) continue;
        this.sharedSent.set(p.id, key);
        p.post({ type: "sharedInfo", cards });
      }
    };
    if (now) run(); else this.sharedT = setTimeout(run, 120);
  }

  private keyOn = false;
  private keyApplied: Promise<unknown> = Promise.resolve();
  async boardFocus(p: BoardPanel, has: boolean) {
    p.hasKeyboard = has;
    const on = this.all().some((x) => x.hasKeyboard);
    if (on !== this.keyOn) {
      this.keyOn = on;
      const set = workspace().ui.boardFocusKey;
      if (set) this.keyApplied = this.keyApplied.then(() => set(on)).catch((e) => log("warn", `boardFocused: ${e instanceof Error ? e.message : e}`));
    }
    await this.keyApplied;
  }

  get(id: string) { return this.panels.get(id); }
  all() { return [...this.panels.values()]; }
  metas(): Promise<BoardMeta[]> { return this.store.list(); }

  async show(id: string, place: ViewPlace = {}): Promise<BoardPanel | undefined> {
    const ex = this.panels.get(id);
    if (ex) { ex.view.reveal(place.preserveFocus); return ex; }
    const b = await this.store.load(id);
    if (!b) return undefined;
    const p = this.attach(id, this.env.openView(id, b.name, place));
    if (!place.preserveFocus) this.setTarget(id);
    return p;
  }

  /** 窗口重新加载后恢复的界面该显示哪块白板：界面记着的那块；它没了或已经开着，就是上次开着、现在还没开的（没有 = undefined） */
  async restoreId(remembered: string | undefined): Promise<string | undefined> {
    let id = remembered;
    if (!id || this.panels.has(id) || !(await this.store.load(id))) id = (workspace().storage.get<string[]>(OPEN) ?? []).find((x) => !this.panels.has(x));
    return id && (await this.store.load(id)) ? id : undefined;
  }

  /** 一个界面开始显示白板 id（新开的、窗口重新加载后恢复的） */
  attach(id: string, view: BoardView): BoardPanel {
    const p = new BoardPanel(id, view, this);
    this.panels.set(id, p);
    view.onMessage((m) => void this.onMessage(p, m));
    // p.id 会变（进入子白板），这里都按 p.id 取
    view.onDidActivate(() => this.setTarget(p.id));
    // 关界面：它最后的改动宿主已经收下了，马上写盘（不等定时器，窗口可能正在关）
    view.onDidDispose(() => { p.dropAsks(); void this.store.flush(p.id); if (this.panels.get(p.id) === p) this.panels.delete(p.id); this.sharedSent.delete(p.id); this.skelSent.delete(p); this.refsSent.delete(p); this.saveOpen(); });
    this.saveOpen();
    return p;
  }

  private async onMessage(p: BoardPanel, m: BoardToHost) {
    const req = "req" in m ? (m as { req: number }).req : undefined;
    const t0 = performance.now();
    try {
      if (m.type === "ready") return void (await p.init());
      const data = (await this.handler(p, m)) as ReplyOf<AskType> | undefined; // 类型由 handlers 按 ReplyOf 检查
      if (req !== undefined) p.post({ type: "reply", req, data: data ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[codeboard]", m.type, e);
      log("error", `${m.type}: ${msg}${e instanceof Error && e.stack ? `\n${e.stack}` : ""}`);
      if (req !== undefined) p.post({ type: "reply", req, error: msg });
      else p.toast(`Error: ${msg}`);
    } finally {
      // 慢的请求记一笔（Copy Diagnostics 里能看到），方便对照白板那边的耗时。要等用户在对话框里选的不算（量到的是用户想了多久）
      const ms = performance.now() - t0;
      if (ms > 150 && m.type !== "confirm" && m.type !== "pickFile" && m.type !== "copyDiagnostics") log("info", `slow ${m.type}: ${Math.round(ms)} ms`);
    }
  }

  private saveOpen() { void workspace().storage.set(OPEN, [...this.panels.keys()]); }

  setTarget(id: string | undefined) {
    if (this.target === id) return;
    this.target = id;
    void workspace().storage.set(TARGET, id);
    for (const p of this.all()) p.post({ type: "host", host: { target: p.id === id } });
    this.targetEmitter.fire();
  }

  broadcast(m: HostToBoard) { for (const p of this.all()) p.post(m); }

  async pushBoards() { const boards = await this.metas(); this.broadcast({ type: "boards", boards }); }

  staleChanged(id: string, n: number) {
    if ((this.store.stale.get(id) ?? 0) === n) return;
    this.store.stale.set(id, n);
    this.staleEmitter.fire();
  }

  async refreshStale(paths?: ReadonlySet<string>) {
    await Promise.all(this.all().filter((p) => !paths || p.holds(paths)).map((p) => p.refreshStale(paths)));
  }
}
