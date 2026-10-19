// 白板面板：一张白板一个 webview 标签页（可以同时开几张）。白板状态由 webview 持有，改动后把变了的项发回来保存（patch）；
// 宿主负责读代码、高亮、版本、跳转，共享卡改了就转给开着同一张卡的别的白板。最近聚焦的白板是编辑器里 Add to 的目标。
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { cutCrumbs, sharedInfo, skeletonOf, subBoardsOf, type AskType, type BoardMeta, type BoardToHost, type Camera, type Crumb, type HostToBoard, type ReplyOf, type Segment, type Skeleton, type WalkHop } from "@codeboard/core";
import type { CardClip } from "@codeboard/core/storage";
import type { Storage } from "./storage";
import { BoardPanel, type BoardHost, type BoardView } from "./boards";
import type { Handler } from "./handlers";
import { log } from "./log";
import { viewsFor } from "./views";
import { variantSegments } from "./versions";

export { BoardPanel };

/** BoardView 的 VS Code 实现：一个 webview 标签页 */
function webviewView(panel: vscode.WebviewPanel): BoardView {
  return {
    postMessage: (m) => void panel.webview.postMessage(m),
    get title() { return panel.title; },
    set title(t: string) { panel.title = t; },
    get visible() { return panel.visible; },
    get active() { return panel.active; },
    reveal: (preserveFocus) => panel.reveal(undefined, preserveFocus),
    dispose: () => panel.dispose(),
    resourceUrl: (dir) => panel.webview.asWebviewUri(vscode.Uri.file(dir)).toString(),
  };
}

export class Panels implements BoardHost {
  static readonly viewType = "codeboard.board";
  private panels = new Map<string, BoardPanel>();
  private webviews = new Map<BoardPanel, vscode.WebviewPanel>();
  target: string | undefined;
  private targetEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTarget = this.targetEmitter.event;
  private staleEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeStale = this.staleEmitter.event;
  handler: Handler = async () => undefined;
  /** ⌘C 复制的卡（贴到别的白板时用） */
  clip: CardClip | undefined;
  /** 共享卡的改动按顺序转发（段的展示数据要先算好） */
  private shareQ: Promise<unknown> = Promise.resolve();

  constructor(private ctx: vscode.ExtensionContext, readonly store: Storage) {
    this.target = ctx.workspaceState.get<string>("codeboard.target");
    // 共享卡写进了卡库：开着同一张卡的别的白板换上（存储里的那份已经换好了）。卡本身变了（新版本、改段）时带上段的展示数据
    ctx.subscriptions.push(store.onDidShare((e) => {
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
    ctx.subscriptions.push(store.onDidMerge((e) => {
      this.shareQ = this.shareQ.then(async () => {
        const p = this.get(e.id);
        if (!p) return;
        const segs = (e.patch.cards?.set ?? []).flatMap((c) => (c.kind === "code" ? [...c.segments, ...variantSegments({ cards: [c] })] : []));
        const views = segs.length ? await viewsFor(segs) : undefined;
        p.board = store.peek(p.id);
        p.post({ type: "merged", patch: e.patch, views });
      }).catch((err) => log("error", `merged: ${err instanceof Error ? err.message : err}`));
    }));
    // Delete Everywhere：开着的别的白板跟着删
    ctx.subscriptions.push(store.onDidRemoveShared((e) => {
      for (const p of this.all()) {
        if (p.id === e.from || !e.boards.includes(p.id)) continue;
        p.board = store.peek(p.id);
        p.post({ type: "sharedGone", cards: [e.card] });
      }
    }));
    // 删掉的白板在面包屑上：那几层回不去了，剪掉
    ctx.subscriptions.push(store.onDidRemoveBoard((id) => {
      for (const p of this.all()) {
        const c = cutCrumbs(p.crumbs, p.cams, id);
        if (!c) continue;
        p.crumbs = c.crumbs; p.cams = c.cams;
        p.post({ type: "crumbs", crumbs: c.crumbs });
      }
    }));
    // 白板的改动写不下去：存储过一会儿自己重试，开着它的面板说一声
    ctx.subscriptions.push(store.onDidFailSave((e) => this.panels.get(e.board)?.toast(`Couldn't save the board: ${e.error}. Retrying…`)));
    ctx.subscriptions.push(store.onDidRecoverSave((id) => this.panels.get(id)?.toast("The board is saved again.")));
    // 共享卡的「⧉ N boards」「← N」：任何白板存盘、改名后重算（只发变了的面板）
    ctx.subscriptions.push(store.onDidSave(() => this.refreshShared()), store.onDidChange(() => this.refreshShared()));
    // 子白板的骨架：子白板存盘后重算（只算存了的那块），白板列表变了（改名、删白板）全部重算；都防抖
    ctx.subscriptions.push(store.onDidSave((b) => { this.dirtySkels.add(b.id); this.refreshSkeletons(); }), store.onDidChange(() => { this.allSkels = true; this.refreshSkeletons(); }));
  }

  private skelT: ReturnType<typeof setTimeout> | undefined;
  /** 每个面板发过的骨架（子白板 id → JSON） */
  private skelSent = new Map<BoardPanel, Map<string, string>>();
  private dirtySkels = new Set<string>();
  private allSkels = false;
  /** 一块白板的骨架（宿主缓存里的那份；没了 = null） */
  skeleton(id: string): Skeleton | null {
    const b = this.store.peek(id);
    return b ? skeletonOf(b, (x) => this.store.peek(x)?.name) : null;
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
      for (const p of this.all()) {
        const b = this.store.peek(p.id);
        if (!p.ready || !b) continue;
        let sent = this.skelSent.get(p);
        if (!sent) this.skelSent.set(p, (sent = new Map()));
        const out: Record<string, Skeleton | null> = {};
        for (const id of subBoardsOf(b)) {
          if (sent.has(id) && !all && !dirty.has(id)) continue;
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

  /**
   * 面板换一块白板显示（进入子白板、从面包屑回去）：白板那边已经存好了（发消息前 flush 过）。
   * 子白板已经在别的面板里开着时切到那个面板（同一块白板不开两份），返回 false
   */
  /** 上次打开的时间（globalState，跨工作区；「回来接上」的提示用） */
  lastOpened(id: string): number | undefined { return this.ctx.globalState.get<Record<string, number>>("codeboard.opened")?.[id]; }
  opened(id: string) {
    const m = { ...(this.ctx.globalState.get<Record<string, number>>("codeboard.opened") ?? {}), [id]: Date.now() };
    void this.ctx.globalState.update("codeboard.opened", m);
  }

  async switchBoard(p: BoardPanel, to: string, o: { crumbs: Crumb[]; cams: Camera[]; walk?: WalkHop; cam?: Camera }): Promise<boolean> {
    const other = this.panels.get(to);
    if (other && other !== p) { other.view.reveal(); return false; }
    if (!(await this.store.load(to))) throw new Error("Board not found.");
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
    this.saveOpen();
    if (this.target === was) this.setTarget(to);
    await p.init();
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

  get(id: string) { return this.panels.get(id); }
  all() { return [...this.panels.values()]; }
  metas(): Promise<BoardMeta[]> { return this.store.list(); }

  /** 打开（或切到）一张白板 */
  async show(id: string, opts: { preserveFocus?: boolean; side?: boolean; here?: boolean } = {}): Promise<BoardPanel | undefined> {
    const ex = this.panels.get(id);
    if (ex) { ex.view.reveal(opts.preserveFocus); return ex; }
    const b = await this.store.load(id);
    if (!b) return undefined;
    // here：侧栏里点的，开在当前这一栏（不新开分栏）
    const col = opts.side ? vscode.ViewColumn.Beside : opts.here ? vscode.ViewColumn.Active : this.boardColumn() ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(Panels.viewType, b.name, { viewColumn: col, preserveFocus: opts.preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
    const p = this.attach(id, panel);
    if (!opts.preserveFocus) this.setTarget(id);
    return p;
  }

  /** 已经有白板开着的那一栏（新白板也开在那里，成为一个新标签） */
  private boardColumn() {
    return this.all().map((p) => this.webviews.get(p)?.viewColumn).find((c) => c);
  }

  /** 窗口重新加载后恢复面板：webview 的 state 里记着白板 id */
  async restore(panel: vscode.WebviewPanel, state: unknown) {
    let id = (state as { __board?: string } | undefined)?.__board;
    if (!id || this.panels.has(id) || !(await this.store.load(id))) {
      const open = this.ctx.workspaceState.get<string[]>("codeboard.open") ?? [];
      id = open.find((x) => !this.panels.has(x));
    }
    if (!id || !(await this.store.load(id))) { panel.dispose(); return; }
    this.attach(id, panel);
  }

  private attach(id: string, panel: vscode.WebviewPanel): BoardPanel {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, vscode.Uri.file(this.store.assetsDir())] };
    panel.iconPath = vscode.Uri.joinPath(media, "icon.svg");
    const p = new BoardPanel(id, webviewView(panel), this);
    this.panels.set(id, p);
    this.webviews.set(p, panel);
    panel.webview.html = this.html(panel.webview, id);
    panel.webview.onDidReceiveMessage((m: BoardToHost) => this.onMessage(p, m));
    // p.id 会变（进入子白板），这里都按 p.id 取
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.setTarget(p.id); });
    // 关面板：它最后的改动宿主已经收下了，马上写盘（不等定时器，窗口可能正在关）
    panel.onDidDispose(() => { void this.store.flush(p.id); if (this.panels.get(p.id) === p) this.panels.delete(p.id); this.webviews.delete(p); this.sharedSent.delete(p.id); this.skelSent.delete(p); this.saveOpen(); });
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
      // 慢的请求记一笔（Copy Diagnostics 里能看到），方便对照白板那边的耗时
      const ms = performance.now() - t0;
      if (ms > 150 && m.type !== "confirm" && m.type !== "pickFile") log("info", `slow ${m.type}: ${Math.round(ms)} ms`);
    }
  }

  private saveOpen() { void this.ctx.workspaceState.update("codeboard.open", [...this.panels.keys()]); }

  setTarget(id: string | undefined) {
    if (this.target === id) return;
    this.target = id;
    void this.ctx.workspaceState.update("codeboard.target", id);
    for (const p of this.all()) p.post({ type: "host", host: { target: p.id === id } });
    this.targetEmitter.fire();
  }

  broadcast(m: HostToBoard) { for (const p of this.all()) p.post(m); }

  /** 白板列表变了：推给所有白板 */
  async pushBoards() { const boards = await this.metas(); this.broadcast({ type: "boards", boards }); }

  staleChanged(id: string, n: number) {
    if ((this.store.stale.get(id) ?? 0) === n) return;
    this.store.stale.set(id, n);
    this.staleEmitter.fire();
  }

  async refreshStale() { await Promise.all(this.all().map((p) => p.refreshStale())); }

  private html(w: vscode.Webview, id: string) {
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join("");
    const dir = path.join(this.ctx.extensionUri.fsPath, "media", "board");
    const u = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "board", f));
    const css = fs.existsSync(path.join(dir, "board.css")) ? `<link rel="stylesheet" href="${u("board.css")}">` : "";
    const csp = [
      "default-src 'none'",
      `img-src ${w.cspSource} data: blob: https: http:`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `font-src ${w.cspSource} data:`,
      // 入口是 ES module：import() 进来的 chunk 也在 media/board 下面
      `script-src 'nonce-${nonce}' ${w.cspSource}`,
    ].join("; ");
    // 在 state 里记下白板 id，窗口重新加载时据此恢复（不影响白板自己用 setState）
    const keep = `(function(){var a=acquireVsCodeApi(),id=${JSON.stringify(id)};var w={postMessage:function(m){a.postMessage(m)},getState:function(){var s=a.getState();if(s&&typeof s==="object"){s=Object.assign({},s);delete s.__board}return s},setState:function(s){a.setState(Object.assign({},s||{},{__board:id}));return s}};var s0=a.getState();a.setState(Object.assign({},s0||{},{__board:id}));window.acquireVsCodeApi=function(){return w}})();`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">${css}<title>CodeBoard</title></head>
<body><div id="root"></div><script nonce="${nonce}">${keep}</script><script type="module" nonce="${nonce}" src="${u("board.js")}"></script></body></html>`;
  }
}
