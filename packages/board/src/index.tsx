// The VS Code webview's entry (board.js): the board talks to the extension through the webview API
import { boot } from "./boot";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

const vscode = acquireVsCodeApi();
boot(
  {
    post: (m) => vscode.postMessage(m),
    listen: (fn) => window.addEventListener("message", (e) => fn(e.data)),
  },
  { selfCheck: import.meta.env.DEV },
);
