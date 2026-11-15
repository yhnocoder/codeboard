#!/usr/bin/env node
// What the web side's code editor (CodeMirror with packages/markdown/src/cm/editor.ts, as a Mac sees it) does with each
// key and click on a set of texts and selections, for CodeCore's CodeEditor to match (Tests/CodeCoreTests/
// CodeMirrorCaseTests.swift). The editor runs in headless Chromium; each text's layout (the row and x of each offset)
// is written too, so the Swift side moves over the same rows:
//   node apps/macos/tools/codemirror-cases.mjs > apps/macos/Tests/CodeCoreTests/Fixtures/codemirror.json
import * as esbuild from "esbuild";
import { launch } from "../../../tools/test/chromium.mjs";

const texts = [
  "",
  "def f(x):\n    return x + 1\n",
  "\tif a:\n\t\tb = [1, 2]\n\n  c  \n",
  "x = foo.bar(baz)  # 注释 等待\nnaïve café ok",
  "  a\n    b\n      c\nd",
  "emoji 👍🏽 end; a+=b->c\n\n",
  "for (i = 0; i < n; i++) {\n    // done\n}",
  "   \n\t \n  x",
  "a  b\t\tc   d\n e",
];
// long lines, wrapped at about 16 columns
const wrapped = [
  "short\nthe quick brown fox jumps over the lazy dog again\nend",
  "    indented words that run past the edge of the box\n",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbb",
];

const keys = [
  ..."ArrowLeft ArrowRight ArrowUp ArrowDown".split(" ").flatMap((k) =>
    ["", "Shift-", "Alt-", "Shift-Alt-", "Meta-", "Shift-Meta-"].map((m) => m + k),
  ),
  ..."Backspace Delete Alt-Backspace Alt-Delete Meta-Backspace Meta-Delete Shift-Backspace".split(" "),
  ..."Ctrl-h Ctrl-d Ctrl-k Ctrl-Alt-h Ctrl-o Ctrl-t Ctrl-l".split(" "),
  ..."a e b f p n".split(" ").flatMap((k) => [`Ctrl-${k}`, `Shift-Ctrl-${k}`]),
  ..."Enter Shift-Enter Tab Shift-Tab Meta-/ Meta-[ Meta-] Shift-Meta-k Meta-a".split(" "),
];
// keys that go by the layout, on wrapped text; a few repeated, for the column vertical moves keep
const wrapKeys = [
  ..."ArrowUp ArrowDown Shift-ArrowUp Shift-ArrowDown Meta-ArrowLeft Meta-ArrowRight".split(" "),
  ..."Shift-Meta-ArrowLeft Shift-Meta-ArrowRight Meta-Backspace Meta-Delete Ctrl-a Ctrl-e Ctrl-k".split(" "),
  "ArrowDown ArrowDown ArrowDown",
  "ArrowUp ArrowUp ArrowUp",
  "ArrowDown ArrowRight ArrowDown",
  "Meta-ArrowRight ArrowDown",
  "Meta-ArrowRight Meta-ArrowRight",
  "Meta-ArrowLeft Meta-ArrowLeft",
];

const page = String.raw`
  window.run = (texts, keys, wrap) => {
    const { codeEditor, EditorSelection } = window.cm;
    const out = { layouts: [], cases: [], clicks: [] };
    const seg = new Intl.Segmenter();
    for (let t = 0; t < texts.length; t++) {
      const text = texts[t];
      const parent = document.createElement("div");
      parent.style.width = wrap ? "calc(16ch + 12px)" : "2000px";
      document.body.append(parent);
      const ed = codeEditor({ parent, text, wrap, comment: () => "#" });
      const view = ed.view;
      const left = view.contentDOM.getBoundingClientRect().left + parseFloat(getComputedStyle(view.contentDOM.firstChild).paddingLeft);
      const cw = view.defaultCharacterWidth;
      // the places a caret can be: grapheme boundaries and line ends
      const at = new Set([0, text.length]);
      for (const s of seg.segment(text)) at.add(s.index);
      const stops = [...at].sort((a, b) => a - b);
      // each offset's row and x (in character widths), before (-1) and after (1) it
      const tops = new Set();
      const coords = stops.map((p) => [-1, 1].map((side) => view.coordsAtPos(p, side)));
      for (const c of coords) for (const r of c) tops.add(Math.round(r.top));
      const rows = [...tops].sort((a, b) => a - b);
      const place = (r) => [rows.indexOf(Math.round(r.top)), +((r.left - left) / cw).toFixed(3)];
      out.layouts.push(stops.map((p, i) => [p, ...place(coords[i][0]), ...place(coords[i][1])]));
      const sels = stops.map((p) => [p, p]);
      if (!wrap)
        for (let i = 0; i + 1 < stops.length; i += 3) {
          const j = Math.min(stops.length - 1, i + 1 + ((i * 7) % 11));
          sels.push([stops[i], stops[j]], [stops[j], stops[i]]);
        }
      if (!wrap && text) sels.push([0, text.length], [text.length, 0]);
      for (const [a, h] of sels)
        for (const k of keys) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: EditorSelection.single(a, h) });
          for (const one of k.split(" ")) press(view, one);
          const s = view.state.selection.main;
          const now = view.state.doc.toString();
          out.cases.push([t, a, h, k, now === text ? null : now, s.anchor, s.head, s.assoc]);
        }
      // clicks: one, two and three (Chromium's event.detail counts them), in the left of the character after each offset and the right of the one before
      if (!wrap)
        for (let i = 0; i < stops.length; i++)
          for (const side of [1, -1]) {
            const p = stops[i];
            const c = view.coordsAtPos(p, side);
            const r = side > 0 ? view.coordsAtPos(stops[i + 1] ?? p, -1) : view.coordsAtPos(stops[i - 1] ?? p, 1);
            if (!c || !r || Math.round(c.top) !== Math.round(r.top) || Math.abs(r.left - c.left) < 1) continue;
            const x = c.left + (r.left - c.left) / 4, y = (c.top + c.bottom) / 2;
            for (let n = 1; n <= 3; n++) {
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
              for (let k = 1; k <= n; k++) {
                const o = { clientX: x, clientY: y, button: 0, buttons: 1, detail: k, bubbles: true };
                view.contentDOM.dispatchEvent(new MouseEvent("mousedown", o));
                document.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
              }
              const s = view.state.selection.main;
              out.clicks.push([t, p, side, n, s.anchor, s.head]);
            }
          }
      ed.destroy();
      parent.remove();
    }
    return out;
  };
  const MOD = { Shift: "shiftKey", Alt: "altKey", Meta: "metaKey", Ctrl: "ctrlKey" };
  function press(view, name) {
    const parts = name.split("-");
    let key = parts.pop();
    const init = { bubbles: true, cancelable: true };
    for (const m of parts) init[MOD[m]] = true;
    const code = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    if (init.shiftKey && key.length === 1) key = key.toUpperCase();
    const e = new KeyboardEvent("keydown", { ...init, key });
    Object.defineProperty(e, "keyCode", { get: () => ({ "/": 191, "[": 219, "]": 221 })[key] ?? code });
    window.cm.runScopeHandlers(view, e, "editor");
  }
`;

const entry = `
  import { codeEditor } from "../../../packages/markdown/src/cm/editor.ts";
  import { runScopeHandlers } from "@codemirror/view";
  import { EditorSelection } from "@codemirror/state";
  window.cm = { codeEditor, runScopeHandlers, EditorSelection };
`;
const bundle = await esbuild.build({
  stdin: { contents: entry, resolveDir: import.meta.dirname, loader: "ts" },
  bundle: true,
  write: false,
  format: "iife",
  logLevel: "error",
});

const browser = await launch();
try {
  const tab = await browser.newPage();
  // a Mac's key names (CodeMirror reads the platform)
  await tab.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  await tab.setContent(
    `<style>body{margin:0} .cm-editor .cm-content{font:14px/20px Menlo, monospace}</style>` +
      `<script>${bundle.outputFiles[0].text.replace(/<\/script/g, "<\\/script")}</script><script>${page}</script>`,
  );
  const plain = await tab.evaluate(([t, k]) => window.run(t, k, false), [texts, keys]);
  const wrap = await tab.evaluate(([t, k]) => window.run(t, k, true), [wrapped, wrapKeys]);
  console.log(JSON.stringify({ texts, keys, ...plain, wrapped: { texts: wrapped, keys: wrapKeys, ...wrap } }));
} finally {
  await browser.close();
}
