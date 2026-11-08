// The board's composition root: what it wires up once, in this order, before a board is shown. Every shell (boot.tsx, the stories)
// calls wireBoard with its own way to the host and renders the board inside MdContext with the Markdown instance it returns;
// nothing here happens by importing a module
import { createEffect, on, untrack } from "solid-js";
import { createMarkdown, type Markdown } from "@yhnocoder/markdown";
import { langId } from "@codeboard/analysis/langs";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { connectHost, followHostTheme, type Transport } from "./host";
import { noteHighlight } from "./cm/load";
import { resolveCardRef, setCardPlayback, setImagePlaybackIn, wireFreshCards, wireVariantViews } from "./actions";
import { installAnims } from "./md/anim";
import { checkEdits } from "./state/changes";
import { measure } from "./state/measure";
import { ghosts } from "./gesture";
import { vscodeKey } from "./ui/vscodekeys";
import { wireSectionEasing } from "./state/sections";
import { wireInk } from "./state/ink";
import { wireSummaries } from "./state/summary";
import { rooted } from "./state/root";
import { wireRefTitles } from "./md/refs";
import { makeCopy } from "./md/copies";
import { stillZ } from "./state/camera";
import { offscreen } from "./state/offscreen";
import { setStill } from "./state/still";

export type { Transport };
export type BoardOptions = {
  /** Check every edit for dangling references (HistoryPorts.selfCheck): dev builds and the harness */
  selfCheck: boolean;
  /** Draw the board as a still, read-only picture (the phone viewer's tiles; state/still.ts). boot then returns the board's
   *  still API (still.ts) */
  still?: boolean;
};

/** Wires the board to its host; returns the board's Markdown instance (Notes, captions, Sidenotes), for MdContext */
export function wireBoard(t: Transport, o: BoardOptions): Markdown {
  setStill(!!o.still);
  // [[refs]] to cards, code blocks highlighted by the host, clipboard and undo keys to VS Code, Mermaid in the board's
  // measuring round, completions held while a card moves; the host sets its preamble and asset address (hostio.ts)
  const md: Markdown = createMarkdown({
    refs: {
      resolve: (label, target) => resolveCardRef(label, md, target),
      missing: "Nothing with this title on the board",
    },
    highlight: noteHighlight,
    langId,
    passKeys: vscodeKey,
    measure,
    ghosts,
    // images show the copy that fits the size they are seen at (md/copies.ts), chosen when the camera stops
    displayScale: () => untrack(stillZ) * devicePixelRatio,
    imageVisible: (img) => {
      const id = img.closest<HTMLElement>(".card[data-id]")?.dataset.id;
      return !id || !offscreen(id);
    },
    makeImageCopy: (src, width) => makeCopy(md, src, width),
  });
  connectHost(t, (m) => onHost(m, md));
  checkEdits(o.selfCheck);
  installKeys(md);
  wireSectionEasing();
  wireVariantViews();
  wireFreshCards();
  installAnims({
    save: (k, p) => (k.whole ? setCardPlayback(k.card, p) : setImagePlaybackIn(k.card, k.src, k.nth, p)),
  });
  followHostTheme();
  wireInk();
  wireSummaries();
  rooted(() => wireRefTitles(md));
  rooted(() => createEffect(on(stillZ, () => md.updateImages(), { defer: true })));
  return md;
}
