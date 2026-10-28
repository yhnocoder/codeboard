import { send } from "./host";

/** Tell the host whenever this frame gets or loses the keyboard (BoardToHost "focus") */
export function reportFocus() {
  window.addEventListener("focus", () => send({ type: "focus", has: true }));
  window.addEventListener("blur", () => send({ type: "focus", has: false }));
  if (document.hasFocus()) send({ type: "focus", has: true });
  keysFromHostPage();
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
