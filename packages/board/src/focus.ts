import { send } from "./host";
import { CLICK_KEEPS_KEYS } from "./state/timing";

/** Tell the host whenever this frame gets or loses the keyboard (BoardToHost "focus") */
export function reportFocus() {
  window.addEventListener("focus", () => send({ type: "focus", has: true }));
  window.addEventListener("blur", () => send({ type: "focus", has: false }));
  if (document.hasFocus()) send({ type: "focus", has: true });
  keysFromHostPage();
  keepAfterPress();
}

/**
 * VS Code gives a webview the keyboard in two steps: it focuses the webview's host page, and 50 ms later posts "focus", on which the
 * host page focuses this frame. VS Code skips the post when it no longer counts the webview as focused, and the host page reports its
 * blurs from a 250 ms poll, so a late blur can land between the two steps: F1 then Escape over the board, or a click on the board
 * while VS Code is still handing it the keyboard. The keyboard then stays on the host page's <body>, which has nothing to type into.
 * A key that lands there is meant for the board: this frame takes the keyboard and handles the key. (Taking the keyboard as soon as
 * the host page gets it is not safe: VS Code may be moving it on by then, as Focus First Editor Group run from the palette does.)
 * frameElement is null when no page of this origin embeds the board (an exported board).
 */
function keysFromHostPage() {
  const host = window.frameElement?.ownerDocument;
  if (!host) return;
  host.addEventListener("keydown", (e) => {
    if (e.target !== host.body || document.hasFocus()) return;
    window.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", e));
  });
}

/**
 * The same two steps after a press on the board: the press gives this frame the keyboard, then VS Code, now counting the webview as
 * focused, focuses its host page (which takes the keyboard out of this frame) and may skip the second step. Right after a press, a blur
 * that leaves the keyboard on the host page's <body> (the host page still has it: VS Code did not move it elsewhere) is that first step,
 * and the frame takes the keyboard back. A blur to anywhere else in VS Code leaves the host page without the keyboard and is kept.
 */
function keepAfterPress() {
  const host = window.frameElement?.ownerDocument;
  if (!host) return;
  let pressed = -Infinity;
  window.addEventListener(
    "pointerdown",
    () => {
      pressed = performance.now();
    },
    true,
  );
  window.addEventListener("blur", () => {
    if (performance.now() - pressed > CLICK_KEEPS_KEYS) return;
    // where the keyboard went is settled after this event
    setTimeout(() => {
      if (!document.hasFocus() && host.hasFocus() && host.activeElement === host.body) window.focus();
    });
  });
}
