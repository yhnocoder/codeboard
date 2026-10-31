// 白板的模式：同一时间只有一个（放贴纸、连线、点一张卡、画 Section）。Esc 取消，#board 的 data-mode 跟着它（光标样式）。
// 拖着平移、按住空格是临时盖在模式上面的，松开就回到原来的模式。
import { createSignal } from "solid-js";
import type { CallSpan, IconRef } from "@codeboard/core";
import { toast, toastMsg, setToastMsg } from "./toast";
import { boardSignal } from "./root";

export type ConnectFrom = { card: string; seg?: string; line?: number; call?: CallSpan };
export type Mode =
  | { kind: "idle" }
  /** 工具栏 Sticker 选好图标后：跟着指针走，点一下放下 */
  | { kind: "place"; icon: IconRef; color?: string }
  /** 工具栏 Arrow / 手动补 Call 箭头：点下一张卡连上 */
  | { kind: "connect"; from: ConnectFrom }
  /** 点一张卡交给 then（Card sidenote、Link Answer） */
  | { kind: "pick"; then: (id: string) => void }
  /** 工具栏 Section：在画布上拖出一个框 */
  | { kind: "draw" };
export type ModeKind = Mode["kind"];

const IDLE: Mode = { kind: "idle" };
const [mode, setMode] = boardSignal<Mode>(IDLE);
export { setMode };
export const idle = () => setMode(IDLE);
export const modeIs = <K extends ModeKind>(k: K): Extract<Mode, { kind: K }> | null => { const m = mode(); return m.kind === k ? (m as Extract<Mode, { kind: K }>) : null; };

export const connectFrom = () => modeIs("connect")?.from ?? null;
export const setConnectFrom = (from: ConnectFrom) => setMode({ kind: "connect", from });
export const placing = () => modeIs("place");

const DRAW_HINT = "Drag on the canvas to draw a section · Esc to cancel";
export function startDraw() { setMode({ kind: "draw" }); toast(DRAW_HINT); }
/** 画完（或取消）：把提示也收掉 */
export function endDraw() { if (modeIs("draw")) idle(); if (toastMsg()?.text === DRAW_HINT) setToastMsg(null); }

export const pickCardThen = (then: (id: string) => void) => setMode({ kind: "pick", then });
/** 点一张卡：交出回调，回到 idle */
export function takePick(): ((id: string) => void) | null { const m = modeIs("pick"); if (m) idle(); return m?.then ?? null; }

/** Esc：取消正在进行的模式；没有模式时返回 false */
export function cancelMode(): boolean {
  const k = mode().kind;
  if (k === "idle") return false;
  if (k === "draw") { endDraw(); return true; }
  idle();
  toast(k === "connect" ? "Connect cancelled" : "Cancelled");
  return true;
}

const [panning, setPanning] = boardSignal(false);
export { setPanning };
// 按着的空格是键盘的状态，不跟白板走（换白板时还按着，松开才收到 keyup）
export const [spaceDown, setSpaceDown] = createSignal(false);
/** #board 的 data-mode */
export const boardMode = (): string | undefined => (panning() ? "pan" : spaceDown() ? "space" : mode().kind === "idle" ? undefined : mode().kind);
