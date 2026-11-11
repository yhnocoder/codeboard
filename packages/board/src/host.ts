import { WAITS_ON_USER, type AskType, type BoardToHost, type HostToBoard, type ReplyOf } from "@codeboard/core";
import { unwrap } from "solid-js/store";
import { onBoardSwitch } from "./state/root";

/** How the board and its host reach each other: the shell that boots the board hands it one (VS Code's webview API, a test's own) */
export type Transport = {
  post(m: BoardToHost): void;
  /** fn gets every message the host sends (checked here, not by the transport) */
  listen(fn: (m: unknown) => void): void;
};
let transport: Transport | undefined;
const post = (m: BoardToHost) => {
  if (!transport) throw new Error("The board is not connected to a host (connectHost)");
  transport.post(m);
};

/** Store proxies can't be posted (DataCloneError): every message is unwrapped here, so callers pass store values as they are */
export function send(m: BoardToHost) {
  post(unwrap(m));
}

let req = 0;
type Pending = { ok: (v: unknown) => void; fail: (e: Error) => void; timer?: number };
const pending = new Map<number, Pending>();
/** How long until an ask the host never answers (an error there, a reload) fails; the ones in WAITS_ON_USER have no limit */
const TIMEOUT = 60_000;

function settle(id: number): Pending | undefined {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  return p;
}
// 换了白板：上一块白板的请求都作废（回答到了也对不上现在的卡）
onBoardSwitch(() => {
  for (const id of [...pending.keys()]) settle(id)?.fail(new Error("The board changed"));
});

type Req<T extends AskType> = Omit<Extract<BoardToHost, { type: T }>, "req" | "type">;

/** 需要回答的请求：宿主用 { type: "reply", req } 回；回答的类型见 core 的 ReplyOf */
export function ask<T extends AskType>(type: T, body: Req<T>): Promise<ReplyOf<T>> {
  const id = ++req;
  return new Promise<ReplyOf<T>>((ok, fail) => {
    const timer = WAITS_ON_USER.has(type)
      ? undefined
      : window.setTimeout(() => settle(id)?.fail(new Error(`No reply from the editor (${type})`)), TIMEOUT);
    pending.set(id, { ok: ok as (v: unknown) => void, fail, timer });
    post(unwrap({ type, req: id, ...body }) as BoardToHost);
  });
}

/** 明暗主题：VS Code 在 body 上挂 vscode-light / vscode-dark / vscode-high-contrast(-light)，白板只认 html[data-theme] */
export function followHostTheme() {
  const sync = () => {
    const c = document.body.classList;
    document.documentElement.dataset.theme =
      c.contains("vscode-light") || c.contains("vscode-high-contrast-light") ? "light" : "dark";
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
    try {
      send({ type: "log", level: "error", text: `board: ${text}`.slice(0, 2000) });
    } catch {
      /* 宿主不在 */
    }
  };
  window.addEventListener("error", (e) =>
    out(
      `${e.message}${e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}:${e.colno}` : ""}${e.error?.stack ? `\n${e.error.stack}` : ""}`,
    ),
  );
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    out(`unhandled rejection: ${r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r)}`);
  });
}

/** Boot: the board talks to its host through t from now on; fn gets the host's messages (replies to ask go to their askers) */
export function connectHost(t: Transport, fn: (m: HostToBoard) => void) {
  transport = t;
  t.listen((x) => {
    const m = x as HostToBoard;
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
