import * as vscode from "vscode";
import { followMap, symbolAt, type Board, type BoardMeta, type BoardToHost, type CardView, type CodeCard, type HostToBoard, type Sym } from "@codeboard/core";
import { Storage } from "./storage";
import { revOf, short } from "./git";
import { absPath, cardForSymbol, currentLines, diffOf, mapToCurrent, newCard, resolveCall, symbolIndex, symbolsOf, viewOf } from "./code";

/**
 * 白板面板：一个 webview，同一时间显示一张白板。
 * 白板状态由 webview 持有，每次改动后整板发回来保存；宿主只负责读代码、算高亮和同步状态、跳转。
 */
export class BoardPanel {
  static readonly viewType = "codeboard.board";
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queue: HostToBoard[] = [];
  board: Board | undefined;
  /** 每张代码卡片最近一次算出的展示数据（编辑器装饰也用它） */
  views: Record<string, CardView> = {};
  private emitter = new vscode.EventEmitter<Board | undefined>();
  readonly onDidChangeBoard = this.emitter.event;

  constructor(private ctx: vscode.ExtensionContext, private store: Storage) {}

  get visible() { return !!this.panel; }

  /** 打开（或切换到）一张白板 */
  async open(id?: string, opts: { preserveFocus?: boolean } = {}) {
    const metas = await this.store.list();
    id ??= this.board?.id ?? this.ctx.workspaceState.get<string>("codeboard.last") ?? metas[0]?.id;
    let board = id ? await this.store.load(id) : null;
    if (!board) board = await this.store.create("第一张白板");
    if (!this.panel) this.create(undefined, opts.preserveFocus);
    else this.panel.reveal(undefined, opts.preserveFocus);
    if (this.board?.id !== board.id || !this.ready) await this.load(board);
  }

  /** 窗口重新加载后恢复面板 */
  async restore(panel: vscode.WebviewPanel) {
    this.create(panel);
    const id = this.ctx.workspaceState.get<string>("codeboard.last");
    const metas = await this.store.list();
    const b = (id && (await this.store.load(id))) || (metas[0] && (await this.store.load(metas[0].id)));
    if (b) await this.load(b);
  }

  private create(existing?: vscode.WebviewPanel, preserveFocus = false) {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    const panel = existing ?? vscode.window.createWebviewPanel(BoardPanel.viewType, "CodeBoard", { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
    });
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.iconPath = vscode.Uri.joinPath(media, "icon.svg");
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: BoardToHost) => this.onMessage(m).catch((e) => this.toast(`出错了：${e?.message ?? e}`)));
    panel.onDidDispose(() => { this.panel = undefined; this.ready = false; this.board = undefined; this.emitter.fire(undefined); });
    this.panel = panel;
    this.ready = false;
  }

  private html(w: vscode.Webview) {
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join("");
    const u = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "board", f));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data: https: http:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${u("board.css")}"><title>CodeBoard</title></head>
<body><div id="root"></div><script nonce="${nonce}" src="${u("board.js")}"></script></body></html>`;
  }

  post(m: HostToBoard) {
    if (this.panel && this.ready) this.panel.webview.postMessage(m);
    else this.queue.push(m);
  }
  toast(text: string) { this.post({ type: "toast", text }); }

  async load(board: Board) {
    this.board = board;
    await this.ctx.workspaceState.update("codeboard.last", board.id);
    if (this.panel) this.panel.title = board.name;
    const views: Record<string, CardView> = {};
    for (const c of board.cards) if (c.type === "code") views[c.id] = await viewOf(c);
    this.views = views;
    const msg: HostToBoard = { type: "load", board, boards: await this.store.list(), views };
    // load 消息总是最先发，排队的消息（比如新加的卡片）跟在后面
    this.queue = this.queue.filter((m) => m.type !== "load");
    if (this.panel && this.ready) this.panel.webview.postMessage(msg);
    else this.queue.unshift(msg);
    this.emitter.fire(board);
  }

  /** 某些文件变了：重算这些文件上所有卡片的同步状态 */
  async refresh(paths?: Set<string>) {
    if (!this.board) return;
    const views: Record<string, CardView> = {};
    for (const c of this.board.cards) if (c.type === "code" && (!paths || paths.has(c.path))) views[c.id] = await viewOf(c);
    Object.assign(this.views, views);
    if (Object.keys(views).length) this.post({ type: "views", views });
  }

  codeCards(): CodeCard[] {
    return (this.board?.cards.filter((c) => c.type === "code") ?? []) as CodeCard[];
  }

  async boards(): Promise<BoardMeta[]> { return this.store.list(); }

  // ---------- webview 发来的消息 ----------

  private async onMessage(m: BoardToHost) {
    switch (m.type) {
      case "ready": {
        this.ready = true;
        if (!this.board) { await this.open(undefined, { preserveFocus: true }); }
        const q = this.queue; this.queue = [];
        for (const x of q) this.panel!.webview.postMessage(x);
        return;
      }
      case "save": {
        const renamed = this.board && this.board.name !== m.board.name;
        this.board = m.board;
        // 新卡片的 id 由白板生成，保存回来时补上它的展示数据
        for (const c of m.board.cards) if (c.type === "code" && !this.views[c.id]) this.views[c.id] = await viewOf(c);
        await this.store.save(m.board);
        if (renamed && this.panel) this.panel.title = m.board.name;
        this.emitter.fire(m.board);
        return;
      }
      case "openCode": return this.openCode(m.id, m.line);
      case "expand": return this.expand(m.id, m.line, m.name, m.recv, m.col);
      case "requestDiff": {
        const c = this.card(m.id);
        const d = c && (await diffOf(c));
        if (!c || !d) return this.toast("这张卡片和当前代码一致");
        const rev = await revOf(absPath(c.path));
        const to = rev.dirty ? `${short(rev.commit)} + 未提交改动` : short(rev.commit);
        return this.post({ type: "diff", id: c.id, lines: d.lines, from: short(c.commit) + (c.dirty ? " + 未提交改动" : ""), to });
      }
      case "follow": {
        const c = this.card(m.id);
        const d = c && (await diffOf(c));
        if (!c || !d) return;
        const rev = await revOf(absPath(c.path));
        const { start, end } = d.s as { start: number; end: number };
        const patch = { start, end, snapshot: d.cur.slice(start - 1, end), commit: rev.commit, dirty: rev.dirty || undefined };
        const lineMap = followMap(c, d.cur, start, end);
        const view = await viewOf({ ...c, ...patch });
        this.views[c.id] = view;
        return this.post({ type: "followed", id: c.id, patch, lineMap, view });
      }
      case "pickCode": return vscode.commands.executeCommand("codeboard.pickSymbol");
      case "switchBoard": { const b = await this.store.load(m.id); if (b) await this.load(b); return; }
      case "newBoard": return vscode.commands.executeCommand("codeboard.newBoard");
      case "openLink": return void vscode.env.openExternal(vscode.Uri.parse(m.url));
    }
  }

  card(id: string) {
    return this.codeCards().find((c) => c.id === id);
  }

  /** 在编辑器里打开卡片对应的代码，定位到某一行 */
  async openCode(id: string, line?: number) {
    const c = this.card(id);
    if (!c) return;
    const lines = await currentLines(c.path);
    if (!lines) return this.toast(`打不开 ${c.path}`);
    const target = await mapToCurrent(c, line ?? c.start);
    const doc = await vscode.workspace.openTextDocument(absPath(c.path));
    // 白板在旁边一栏时，代码开在白板另一侧
    const col = this.panel?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: col, preserveFocus: false });
    const pos = new vscode.Position(target - 1, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    flash(ed, target);
  }

  /** 点了卡片上的调用：找到定义，放一张新卡片并连箭头 */
  async expand(id: string, line: number, name: string, recv: string | undefined, col: number) {
    const c = this.card(id);
    if (!c) return;
    let cands = await resolveCall(c, line, name, recv, col);
    if (!cands.length) return this.toast(`没找到 ${name} 的定义`);
    if (cands.length > 1) {
      const pick = await vscode.window.showQuickPick(
        cands.map((e) => ({ label: e.sym.qual, description: `${e.path}:${e.sym.start}`, e })),
        { placeHolder: `有 ${cands.length} 个叫 ${name} 的定义，选一个展开` },
      );
      if (!pick) return;
      cands = [pick.e];
    }
    const nc = await cardForSymbol(cands[0].path, cands[0].sym);
    if (!nc) return;
    const view = await viewOf({ ...nc, id: "", x: 0, y: 0, w: 0, hl: [] });
    this.post({ type: "addCode", card: nc, view, from: { card: id, line } });
  }

  /** 从编辑器加一张卡片到当前白板（白板没开就先打开） */
  async addCard(rel: string, start: number, end: number, sym?: Sym) {
    const nc = sym ? await cardForSymbol(rel, sym) : await newCard(rel, start, end);
    if (!nc) return;
    if (!sym) {
      // 片段卡片：标题写上它在哪个函数里
      const s = symbolAt(await symbolsOf(rel, nc.snapshot.length ? (await currentLines(rel)) ?? [] : []), start);
      if (s) nc.title = `${s.qual} · ${start}–${end}`;
    }
    const view = await viewOf({ ...nc, id: "", x: 0, y: 0, w: 0, hl: [] });
    await this.open(undefined, { preserveFocus: true });
    this.post({ type: "addCode", card: nc, view });
  }

  focus(id: string) { this.post({ type: "focusCard", id }); }

  warmIndex() { void symbolIndex(); }
}

const flashDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: "rgba(217,119,87,0.22)", isWholeLine: true });
function flash(ed: vscode.TextEditor, line: number) {
  ed.setDecorations(flashDeco, [new vscode.Range(line - 1, 0, line - 1, 0)]);
  setTimeout(() => ed.setDecorations(flashDeco, []), 900);
}
