// The board's composition root: what it wires up once, in this order, before a board is shown. Every shell (boot.tsx, the stories)
// calls wireBoard with its own way to the host; nothing here happens by importing a module
import { setRefResolver, setCodeHighlighter } from "@yhnocoder/markdown";
import { langId } from "@codeboard/analysis/langs";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { connectHost, followHostTheme, type Transport } from "./host";
import { noteHighlight } from "./cm/load";
import { resolveCardRef, wireFreshCards, wireVariantViews } from "./actions";
import { checkEdits } from "./state/changes";
import { wireMeasure } from "./state/measure";
import { wireSectionEasing } from "./state/sections";

export type { Transport };
export type BoardOptions = {
  /** Check every edit for dangling references (HistoryPorts.selfCheck): dev builds and the harness */
  selfCheck: boolean;
};

export function wireBoard(t: Transport, o: BoardOptions) {
  connectHost(t, onHost);
  checkEdits(o.selfCheck);
  wireMeasure();
  installKeys();
  setRefResolver(resolveCardRef, { missing: "Nothing with this title on the board" });
  setCodeHighlighter(noteHighlight, langId);
  wireSectionEasing();
  wireVariantViews();
  wireFreshCards();
  followHostTheme();
}
