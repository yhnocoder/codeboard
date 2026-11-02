// The board's composition root: what it wires up once, in this order, before a board is shown. Every shell (boot.tsx, the stories)
// calls wireBoard with its own way to the host and renders the board inside MdContext with the Markdown instance it returns;
// nothing here happens by importing a module
import { createMarkdown, type Markdown } from "@yhnocoder/markdown";
import { langId } from "@codeboard/analysis/langs";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { connectHost, followHostTheme, type Transport } from "./host";
import { noteHighlight } from "./cm/load";
import { resolveCardRef, wireFreshCards, wireVariantViews } from "./actions";
import { checkEdits } from "./state/changes";
import { measure } from "./state/measure";
import { ghosts } from "./gesture";
import { vscodeKey } from "./ui/vscodekeys";
import { wireSectionEasing } from "./state/sections";

export type { Transport };
export type BoardOptions = {
  /** Check every edit for dangling references (HistoryPorts.selfCheck): dev builds and the harness */
  selfCheck: boolean;
};

/** Wires the board to its host; returns the board's Markdown instance (Notes, captions, Sidenotes), for MdContext */
export function wireBoard(t: Transport, o: BoardOptions): Markdown {
  // [[refs]] to cards, code blocks highlighted by the host, clipboard and undo keys to VS Code, Mermaid in the board's
  // measuring round, completions held while a card moves; the host sets its preamble and asset address (hostio.ts)
  const md: Markdown = createMarkdown({
    refs: { resolve: (label) => resolveCardRef(label, md), missing: "Nothing with this title on the board" },
    highlight: noteHighlight,
    langId,
    passKeys: vscodeKey,
    measure,
    ghosts,
  });
  connectHost(t, (m) => onHost(m, md));
  checkEdits(o.selfCheck);
  installKeys(md);
  wireSectionEasing();
  wireVariantViews();
  wireFreshCards();
  followHostTheme();
  return md;
}
