import type { BoardToHost, HostToBoard } from "@codeboard/core";

// 宿主桥：VS Code webview 用 acquireVsCodeApi；以后 Electron 换一个实现即可
type Api = { postMessage(m: unknown): void };
declare global {
  interface Window { acquireVsCodeApi?: () => Api }
}

const api: Api = window.acquireVsCodeApi?.() ?? { postMessage: (m) => console.debug("[host]", m) };

export function send(m: BoardToHost) {
  api.postMessage(m);
}

export function listen(fn: (m: HostToBoard) => void) {
  window.addEventListener("message", (e) => fn(e.data as HostToBoard));
}
