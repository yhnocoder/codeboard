// The board's composition root: what it wires up once, in this order, before a board is shown. Every shell (the VS Code webview
// in index.tsx, the stories) calls wireBoard; nothing here happens by importing a module
import { setRefResolver, setCodeHighlighter } from "@yhnocoder/markdown";
import { langId } from "@codeboard/analysis/langs";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { listen, followHostTheme } from "./host";
import { noteHighlight } from "./cm/load";
import { resolveCardRef, wireFreshCards, wireVariantViews } from "./actions";
import { wireMeasure } from "./state/measure";
import { wireSectionEasing } from "./state/sections";

export function wireBoard() {
  wireMeasure();
  listen(onHost);
  installKeys();
  setRefResolver(resolveCardRef, { missing: "Nothing with this title on the board" });
  setCodeHighlighter(noteHighlight, langId);
  wireSectionEasing();
  wireVariantViews();
  wireFreshCards();
  followHostTheme();
}
