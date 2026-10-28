import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type { BoardToHost } from "@codeboard/core";
import type { BoardView } from "@codeboard/host/boards";
import type { HostEnv } from "@codeboard/host/env";
import type { BoardHub } from "@codeboard/host/hub";
import type { Storage } from "@codeboard/host/storage";

export const VIEW_TYPE = "codeboard.board";

function webviewView(panel: vscode.WebviewPanel): BoardView {
  return {
    postMessage: (m) => void panel.webview.postMessage(m),
    get title() { return panel.title; },
    set title(t: string) { panel.title = t; },
    get visible() { return panel.visible; },
    get active() { return panel.active; },
    reveal: (preserveFocus) => panel.reveal(undefined, preserveFocus),
    // The board is the active editor when this is called: focusing its group focuses it
    focus: async () => { await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup"); },
    dispose: () => panel.dispose(),
    resourceUrl: (dir) => panel.webview.asWebviewUri(vscode.Uri.file(dir)).toString(),
    onMessage: (fn) => panel.webview.onDidReceiveMessage((m: BoardToHost) => fn(m)),
    onDidActivate: (fn) => panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) fn(); }),
    onDidDispose: (fn) => panel.onDidDispose(() => fn()),
  };
}

export class BoardWebviews {
  private open = new Set<vscode.WebviewPanel>();

  constructor(private ctx: vscode.ExtensionContext, private store: Storage) {}

  env(): HostEnv {
    return {
      globalState: { get: (k) => this.ctx.globalState.get(k), set: async (k, v) => { await this.ctx.globalState.update(k, v); } },
      openView: (id, title, place) => {
        const col = place.side ? vscode.ViewColumn.Beside : place.here ? vscode.ViewColumn.Active : this.boardColumn() ?? vscode.ViewColumn.Beside;
        const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, { viewColumn: col, preserveFocus: place.preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
        return this.setup(panel, id);
      },
    };
  }

  async restore(hub: BoardHub, panel: vscode.WebviewPanel, state: unknown) {
    const id = await hub.restoreId((state as { __board?: string } | undefined)?.__board);
    if (!id) { panel.dispose(); return; }
    hub.attach(id, this.setup(panel, id));
  }

  private boardColumn() {
    return [...this.open].map((p) => p.viewColumn).find((c) => c);
  }

  private setup(panel: vscode.WebviewPanel, id: string): BoardView {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, vscode.Uri.file(this.store.assetsDir())] };
    panel.iconPath = vscode.Uri.joinPath(media, "icon.svg");
    panel.webview.html = this.html(panel.webview, id);
    this.open.add(panel);
    panel.onDidDispose(() => this.open.delete(panel));
    return webviewView(panel);
  }

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
