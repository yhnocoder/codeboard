import type { BoardToHost, HostToBoard } from "@codeboard/core";

// 宿主桥：VS Code webview 用 acquireVsCodeApi；以后 macOS app 换一个实现即可
type Api = { postMessage(m: unknown): void };
declare global {
  interface Window { acquireVsCodeApi?: () => Api; __cbSent?: unknown[] }
}

const api: Api = window.acquireVsCodeApi?.() ?? { postMessage: (m) => (window.__cbSent ??= []).push(m) };

export function send(m: BoardToHost) {
  api.postMessage(m);
}

let req = 0;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();

type Req<T extends BoardToHost["type"]> = Omit<Extract<BoardToHost, { type: T }>, "req" | "type">;

/** 需要回答的请求：宿主用 { type: "reply", req } 回 */
export function ask<R = unknown, T extends BoardToHost["type"] = BoardToHost["type"]>(type: T, body: Req<T>): Promise<R> {
  const id = ++req;
  return new Promise<R>((ok, fail) => {
    pending.set(id, { ok, fail });
    api.postMessage({ type, req: id, ...body });
  });
}

/** 明暗主题：VS Code 在 body 上挂 vscode-light / vscode-dark / vscode-high-contrast(-light)，白板只认 html[data-theme] */
export function followHostTheme() {
  const sync = () => {
    const c = document.body.classList;
    document.documentElement.dataset.theme = c.contains("vscode-light") || c.contains("vscode-high-contrast-light") ? "light" : "dark";
  };
  sync();
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

export function listen(fn: (m: HostToBoard) => void) {
  window.addEventListener("message", (e) => {
    const m = e.data as HostToBoard;
    if (!m || typeof m !== "object" || !("type" in m)) return;
    if (m.type === "reply") {
      const p = pending.get(m.req);
      if (!p) return;
      pending.delete(m.req);
      if (m.error) p.fail(new Error(m.error));
      else p.ok(m.data);
      return;
    }
    fn(m);
  });
}
