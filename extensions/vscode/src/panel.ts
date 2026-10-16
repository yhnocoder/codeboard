// 白板面板：一张白板一个 webview 标签页（可以同时开几张）。白板状态由 webview 持有，每次改动整板发回来保存；
// 宿主负责读代码、高亮、版本、跳转。最近聚焦的白板是编辑器里 Add to 的目标。
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Board, BoardMeta, BoardToHost, HostInfo, HostToBoard, Stale } from "@codeboard/core";
import type { Storage } from "./storage";
import { boardSegments, countStale, staleFor } from "./versions";
import { viewsFor } from "./views";
import { present, srcLabel } from "./source";
import { readSettings } from "./settings";
import { log } from "./log";

export type Handler = (p: BoardPanel, m: BoardToHost) => Promise<unknown> | unknown;

export class BoardPanel {
  board: Board | undefined;
  ready = false;
  private queue: HostToBoard[] = [];
  /** 白板上选中的卡和行（Add to Selected Card、⌥S 用） */
  selection: Extract<BoardToHost, { type: "selection" }> | undefined;
  stale: Record<string, Stale> = {};
  readonly: string | undefined;

  constructor(readonly id: string, readonly panel: vscode.WebviewPanel, private mgr: Panels) {}

  get visible() { return this.panel.visible; }

  post(m: HostToBoard) {
    if (this.ready) void this.panel.webview.postMessage(m);
    else if (m.type !== "init") this.queue.push(m);
  }
  toast(text: string) { this.post({ type: "toast", text }); }

  /** webview 说 ready：读白板、算所有段的展示数据和版本状态，发 init */
  async init() {
    const b = await this.mgr.store.load(this.id);
    if (!b) { this.panel.dispose(); return; }
    this.board = b;
    this.panel.title = b.name;
    const segs = boardSegments(b);
    const [views, stale, boards] = await Promise.all([viewsFor(segs), staleFor(segs), this.mgr.metas()]);
    this.stale = stale;
    this.readonly = await this.readonlyNote(b);
    void this.panel.webview.postMessage({ type: "init", board: b, boards, views, stale, host: this.host() } satisfies HostToBoard);
    this.ready = true;
    const q = this.queue;
    this.queue = [];
    for (const m of q) void this.panel.webview.postMessage(m);
    this.mgr.staleChanged(this.id, countStale(b, stale));
  }

  host(): HostInfo {
    const ed = vscode.workspace.getConfiguration("editor");
    return {
      fontFamily: ed.get<string>("fontFamily"),
      isMac: process.platform === "darwin",
      forwardedKeys: ["k", "d", "0", "1", "=", "+", "-", "shift+l", ","], // 与 package.json 里 codeboard.boardKey 的键一致
      assetBase: this.panel.webview.asWebviewUri(vscode.Uri.file(this.mgr.store.assetsDir())).toString(),
      readonly: this.readonly,
      settings: readSettings(),
      target: this.mgr.target === this.id,
    };
  }

  /** 仓库找不到时的提示（只读快照） */
  private async readonlyNote(b: Board): Promise<string | undefined> {
    const miss = new Set<string>();
    for (const s of boardSegments(b)) if (s.src.kind !== "free" && s.src.kind !== "github" && !(await present(s))) miss.add(srcLabel(s.src));
    if (!miss.size) return undefined;
    const names = [...miss].map((n) => `“${n}”`).join(", ");
    return `Repo ${names} not found in this workspace. Showing saved code, read-only.`;
  }

  /** 重算版本状态并推给白板 */
  async refreshStale() {
    if (!this.board || !this.ready) return;
    const st = await staleFor(boardSegments(this.board));
    const changed = JSON.stringify(st) !== JSON.stringify(this.stale);
    this.stale = st;
    if (changed) this.post({ type: "stale", stale: st });
    this.mgr.staleChanged(this.id, countStale(this.board, st));
  }

  /** Locate Repo 之后：重新读代码、只读提示 */
  async reload() {
    if (!this.board) return;
    const segs = boardSegments(this.board);
    this.readonly = await this.readonlyNote(this.board);
    this.post({ type: "views", views: await viewsFor(segs) });
    this.post({ type: "host", host: { readonly: this.readonly } });
    await this.refreshStale();
  }
}

export class Panels {
  static readonly viewType = "codeboard.board";
  private panels = new Map<string, BoardPanel>();
  target: string | undefined;
  private targetEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTarget = this.targetEmitter.event;
  private staleEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeStale = this.staleEmitter.event;
  handler: Handler = () => undefined;

  constructor(private ctx: vscode.ExtensionContext, readonly store: Storage) {
    this.target = ctx.workspaceState.get<string>("codeboard.target");
  }

  get(id: string) { return this.panels.get(id); }
  all() { return [...this.panels.values()]; }
  metas(): Promise<BoardMeta[]> { return this.store.list(); }

  /** 打开（或切到）一张白板 */
  async show(id: string, opts: { preserveFocus?: boolean; side?: boolean; here?: boolean } = {}): Promise<BoardPanel | undefined> {
    const ex = this.panels.get(id);
    if (ex) { ex.panel.reveal(undefined, opts.preserveFocus); return ex; }
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
    return this.all().find((p) => p.panel.viewColumn)?.panel.viewColumn;
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
    const p = new BoardPanel(id, panel, this);
    this.panels.set(id, p);
    panel.webview.html = this.html(panel.webview, id);
    panel.webview.onDidReceiveMessage((m: BoardToHost) => this.onMessage(p, m));
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.setTarget(id); });
    panel.onDidDispose(() => { this.panels.delete(id); this.saveOpen(); });
    this.saveOpen();
    return p;
  }

  private async onMessage(p: BoardPanel, m: BoardToHost) {
    const req = "req" in m ? (m as { req: number }).req : undefined;
    try {
      if (m.type === "ready") return void (await p.init());
      const data = await this.handler(p, m);
      if (req !== undefined) p.post({ type: "reply", req, data: data ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[codeboard]", m.type, e);
      log("error", `${m.type}: ${msg}${e instanceof Error && e.stack ? `\n${e.stack}` : ""}`);
      if (req !== undefined) p.post({ type: "reply", req, error: msg });
      else p.toast(`Error: ${msg}`);
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
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    // 在 state 里记下白板 id，窗口重新加载时据此恢复（不影响白板自己用 setState）
    const keep = `(function(){var a=acquireVsCodeApi(),id=${JSON.stringify(id)};var w={postMessage:function(m){a.postMessage(m)},getState:function(){var s=a.getState();if(s&&typeof s==="object"){s=Object.assign({},s);delete s.__board}return s},setState:function(s){a.setState(Object.assign({},s||{},{__board:id}));return s}};var s0=a.getState();a.setState(Object.assign({},s0||{},{__board:id}));window.acquireVsCodeApi=function(){return w}})();`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">${css}<title>CodeBoard</title></head>
<body><div id="root"></div><script nonce="${nonce}">${keep}</script><script nonce="${nonce}" src="${u("board.js")}"></script></body></html>`;
  }
}
