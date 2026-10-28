import type { AskType, BoardToHost, HostToBoard, ReplyOf } from "@codeboard/core";
import { onBoardSwitch } from "./state/root";

type Api = { postMessage(m: unknown): void };
declare global {
  interface Window { acquireVsCodeApi?: () => Api; __cbSent?: unknown[] }
}

const api: Api = window.acquireVsCodeApi?.() ?? { postMessage: (m) => (window.__cbSent ??= []).push(m) };

export function send(m: BoardToHost) {
  api.postMessage(m);
}

let req = 0;
type Pending = { ok: (v: any) => void; fail: (e: Error) => void; timer?: number };
const pending = new Map<number, Pending>();
/** 宿主一直不回（出错、重载了）时多久算失败；等用户操作的请求（确认框、选文件、保存对话框、GitHub 登录）不限时 */
const TIMEOUT = 60_000;
const WAITS_ON_USER = new Set<AskType>(["confirm", "pickFile", "exportFile", "deleteEverywhere", "deleteBoard", "newBoard", "gh", "github"]);

function settle(id: number): Pending | undefined {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  return p;
}
// 换了白板：上一块白板的请求都作废（回答到了也对不上现在的卡）
onBoardSwitch(() => { for (const id of [...pending.keys()]) settle(id)?.fail(new Error("The board changed")); });

type Req<T extends AskType> = Omit<Extract<BoardToHost, { type: T }>, "req" | "type">;

/** 需要回答的请求：宿主用 { type: "reply", req } 回；回答的类型见 core 的 ReplyOf */
export function ask<T extends AskType>(type: T, body: Req<T>): Promise<ReplyOf<T>> {
  const id = ++req;
  return new Promise<ReplyOf<T>>((ok, fail) => {
    const timer = WAITS_ON_USER.has(type) ? undefined : window.setTimeout(() => settle(id)?.fail(new Error(`No reply from the editor (${type})`)), TIMEOUT);
    pending.set(id, { ok, fail, timer });
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

/** 白板里的报错转给宿主：写进 Output 的 CodeBoard 频道，Copy Diagnostics 会带上（同一条 5 秒内只发一次） */
export function forwardErrors() {
  const seen = new Map<string, number>();
  const out = (text: string) => {
    const now = Date.now();
    if (now - (seen.get(text) ?? 0) < 5000) return;
    seen.set(text, now);
    try { send({ type: "log", level: "error", text: `board: ${text}`.slice(0, 2000) }); } catch { /* 宿主不在 */ }
  };
  window.addEventListener("error", (e) => out(`${e.message}${e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}:${e.colno}` : ""}${e.error?.stack ? `\n${e.error.stack}` : ""}`));
  window.addEventListener("unhandledrejection", (e) => { const r = e.reason; out(`unhandled rejection: ${r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r)}`); });
}

export function listen(fn: (m: HostToBoard) => void) {
  window.addEventListener("message", (e) => {
    const m = e.data as HostToBoard;
    if (!m || typeof m !== "object" || !("type" in m)) return;
    if (m.type === "reply") {
      const p = settle(m.req);
      if (!p) return;
      if (m.error) p.fail(new Error(m.error));
      else p.ok(m.data);
      return;
    }
    fn(m);
  });
}
