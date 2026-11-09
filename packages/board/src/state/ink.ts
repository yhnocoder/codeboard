// Ink Wash's images wired to the board (drawn by inkart.ts): the paper of each card (Card.tsx paperOf) and the strokes under
// calls and in the toolbar, set as variables on the root while the look is Ink Wash (wireInk), light / dark following html[data-theme]
import { createEffect, createSignal } from "solid-js";
import { shape } from "./look";
import { rooted } from "./root";
import { barSvg, callSvg, CALL_STROKES } from "./inkart";

export { paperOf, paperSheet } from "./inkart";

// ---------- light / dark ----------
// html[data-theme] follows VS Code (host.ts followHostTheme); wireInk watches it, so the paper images can follow it
const [dark, setDark] = createSignal(false);
export { dark as inkDark };

/** The root variables the Ink Wash rules read (themes.css): set while the look draws on paper (look.ts paper, Ink Wash), for
 *  light or dark; gone otherwise. Also follows html[data-theme] for inkDark. Wired once (wire.ts) */
const VARS = ["--ink-bar", "--ink-bar-mask", ...CALL_STROKES.map((_, k) => `--ink-cb${k}`)];
export function wireInk() {
  const root = document.documentElement;
  const sync = () => setDark(root.dataset.theme === "dark");
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  rooted(() =>
    createEffect(() => {
      const on = shape().paper === "deckle",
        dk = dark();
      if (!on) {
        for (const v of VARS) root.style.removeProperty(v);
        return;
      }
      const zhu = dk ? "#d6533a" : "#b8321f",
        ink = dk ? "#e9e5da" : "#1d1c1a";
      root.style.setProperty("--ink-bar", barSvg(ink, dk));
      root.style.setProperty("--ink-bar-mask", barSvg("#000", dk, true));
      for (let k = 0; k < CALL_STROKES.length; k++) root.style.setProperty(`--ink-cb${k}`, callSvg(zhu, k));
    }),
  );
}
