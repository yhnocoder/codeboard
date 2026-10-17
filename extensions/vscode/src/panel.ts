// 白板面板：一张白板一个 webview 标签页（可以同时开几张）。白板状态由 webview 持有，每次改动整板发回来保存；
// 宿主负责读代码、高亮、版本、跳转。最近聚焦的白板是编辑器里 Add to 的目标。
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type { AskType, BoardMeta, BoardToHost, HostToBoard, ReplyOf } from "@codeboard/core";
import type { Storage } from "./storage";
import { BoardPanel, type BoardHost, type BoardView } from "./boards";
import type { Handler } from "./handlers";
import { log } from "./log";

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

  constructor(private ctx: vscode.ExtensionContext, readonly store: Storage) {
    this.target = ctx.workspaceState.get<string>("codeboard.target");
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
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.setTarget(id); });
    panel.onDidDispose(() => { this.panels.delete(id); this.webviews.delete(p); this.saveOpen(); });
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
