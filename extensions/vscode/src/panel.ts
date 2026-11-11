import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { BoardToHost } from "@codeboard/core";
import type { BoardHub, BoardView, HostEnv } from "@codeboard/host";

export const VIEW_TYPE = "codeboard.board";

function webviewView(panel: vscode.WebviewPanel): BoardView {
  return {
    postMessage: (m) => void panel.webview.postMessage(m),
    get title() {
      return panel.title;
    },
    set title(t: string) {
      panel.title = t;
    },
    get visible() {
      return panel.visible;
    },
    get active() {
      return panel.active;
    },
    reveal: (preserveFocus) => panel.reveal(undefined, preserveFocus),
    // The board is the active editor when this is called: focusing its group focuses it
    focus: async () => {
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    },
    dispose: () => panel.dispose(),
    resourceUrl: (dir) => panel.webview.asWebviewUri(vscode.Uri.file(dir)).toString(),
    onMessage: (fn) => panel.webview.onDidReceiveMessage((m: BoardToHost) => fn(m)),
    onDidActivate: (fn) =>
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) fn();
      }),
    onDidDispose: (fn) => panel.onDidDispose(() => fn()),
  };
}

export class BoardWebviews {
  private open = new Set<vscode.WebviewPanel>();

  constructor(private ctx: vscode.ExtensionContext) {
    // 白板界面是构建出来的（npm run build）：少了就是构建坏了，激活时说清楚，不开一块没样式的白板
    const dir = path.join(ctx.extensionUri.fsPath, "media", "board");
    for (const f of ["board.js", "boot.js", "board.css"])
      if (!fs.existsSync(path.join(dir, f)))
        throw new Error(`CodeBoard: ${path.join(dir, f)} is missing (build the board with npm run build)`);
  }

  env(): HostEnv {
    return {
      globalState: {
        get: (k) => this.ctx.globalState.get(k),
        set: async (k, v) => {
          await this.ctx.globalState.update(k, v);
        },
      },
      openView: (id, title, place, roots) => {
        const col = place.side
          ? vscode.ViewColumn.Beside
          : place.here
            ? vscode.ViewColumn.Active
            : (this.boardColumn() ?? vscode.ViewColumn.Beside);
        const panel = vscode.window.createWebviewPanel(
          VIEW_TYPE,
          title,
          { viewColumn: col, preserveFocus: place.preserveFocus },
          { enableScripts: true, retainContextWhenHidden: true },
        );
        return this.setup(panel, id, roots);
      },
    };
  }

  async restore(hub: BoardHub, panel: vscode.WebviewPanel, state: unknown) {
    const id = await hub.restoreId((state as { __board?: string } | undefined)?.__board);
    if (!id) {
      panel.dispose();
      return;
    }
    hub.attach(id, this.setup(panel, id, hub.viewRoots()));
  }

  private boardColumn() {
    return [...this.open].map((p) => p.viewColumn).find((c) => c);
  }

  /** roots = the folders of the board's images and their smaller copies: the webview may read them */
  private setup(panel: vscode.WebviewPanel, id: string, roots: string[]): BoardView {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [media, ...roots.map((r) => vscode.Uri.file(r))],
    };
    panel.iconPath = vscode.Uri.joinPath(media, "icon.svg");
    panel.webview.html = this.html(panel.webview, id);
    this.open.add(panel);
    panel.onDidDispose(() => this.open.delete(panel));
    return webviewView(panel);
  }

  private html(w: vscode.Webview, id: string) {
    const nonce = randomBytes(16).toString("base64");
    const u = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "board", f));
    const csp = [
      "default-src 'none'",
      `img-src ${w.cspSource} data: blob: https: http:`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `font-src ${w.cspSource} data:`,
      // 入口是 ES module：import() 进来的 chunk 也在 media/board 下面
      `script-src 'nonce-${nonce}' ${w.cspSource}`,
    ].join("; ");
    // The board's id goes into the webview's state, which restore() reads when the window reloads. acquireVsCodeApi() can be
    // called once per page, so the same object is handed on to board.js
    const keep = `(function(){var a=acquireVsCodeApi();a.setState({__board:${JSON.stringify(id)}});window.acquireVsCodeApi=function(){return a}})();`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${u("board.css")}"><title>CodeBoard</title></head>
<body><div id="root"></div><script nonce="${nonce}">${keep}</script><script type="module" nonce="${nonce}" src="${u("board.js")}"></script></body></html>`;
  }
}
