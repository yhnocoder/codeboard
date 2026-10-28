import { send } from "./host";

/** Tell the host whenever this frame gets or loses the keyboard (BoardToHost "focus") */
export function reportFocus() {
  window.addEventListener("focus", () => send({ type: "focus", has: true }));
  window.addEventListener("blur", () => send({ type: "focus", has: false }));
  if (document.hasFocus()) send({ type: "focus", has: true });
}
