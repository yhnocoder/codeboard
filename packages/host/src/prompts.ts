// Where CodeBoard asks the user something: in a dialog on the board the question comes from, so the keyboard stays where the user works
// (VS Code hands it back to the board's webview a moment after a quick input over it closes, and an input box shown in that moment
// loses it), or in VS Code's own input box and quick pick when no board is involved (the sidebar, a code editor)
import type { InputOpts, PickItem, PickOpts } from "@codeboard/core";
import type { BoardPanel } from "./boards";
import { workspace } from "./ws";

export type Prompts = {
  input(o: InputOpts): Promise<string | undefined>;
  pick<T extends PickItem>(items: T[], o?: PickOpts): Promise<T | undefined>;
};

// The board has no codicons
const plain = (s: string | undefined) => s?.replace(/\$\([\w-]+\)\s*/g, "");

/** p: the board the question comes from (its own request, or a command run on it while it is the active editor) */
export function prompts(p: BoardPanel | undefined): Prompts {
  if (!p) return workspace().ui;
  // The board may be a moment from getting the keyboard back (from a quick input), or not have it (a command from the palette run
  // with the keyboard in the Explorer): give it the keyboard first. focus() resolves once VS Code has started moving the keyboard, which
  // reaches the board's frame some time later; the dialog takes it when it arrives (packages/board/src/ui/Menu.tsx)
  const ask = async (a: Parameters<BoardPanel["ask"]>[0]) => { if (!p.hasKeyboard) await p.view.focus(); return p.ask(a); };
  return {
    input: async (o) => {
      const v = await ask({ kind: "text", title: o.title ?? o.prompt, text: o.title && o.title.toLowerCase() !== o.prompt.toLowerCase() ? o.prompt : undefined, value: o.value, placeholder: o.placeHolder, ok: o.ok ?? "OK", password: o.password });
      return typeof v === "string" ? v : undefined;
    },
    pick: async (items, o) => {
      const v = await ask({ kind: "pick", title: o?.title ?? o?.placeHolder ?? "", items: items.map((x) => ({ label: plain(x.label)!, description: plain(x.description), detail: plain(x.detail) })) });
      return typeof v === "number" ? items[v] : undefined;
    },
  };
}
