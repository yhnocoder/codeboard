import { createSignal } from "solid-js";

export type ToastT = { text: string; actions?: { label: string; run: () => void }[]; n: number };
export const [toastMsg, setToastMsg] = createSignal<ToastT | null>(null);
let toastTimer: number | undefined, toastN = 0;
export function toast(text: string, actions?: ToastT["actions"], ms = 2600) {
  setToastMsg({ text, actions, n: ++toastN });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToastMsg(null), actions ? Math.max(ms, 5000) : ms);
}
