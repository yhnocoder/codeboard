// Bundles the JavaScript side for JavaScriptCore: one IIFE, no Node, no DOM (apps/macos/build.sh runs it, then builds the Swift app),
// and writes the board's colour tokens (themes.mjs) for Theme.swift
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { build } from "esbuild";
import { decompress } from "wawoff2";
import { icons, sealMasks, themes } from "./themes.mjs";

mkdirSync("dist", { recursive: true });
writeFileSync("dist/themes.json", JSON.stringify(themes()));
writeFileSync("dist/icons.json", JSON.stringify(icons()));
// Ink Wash's seal masks (the grain tile, the rough edge) and the board's background scenes (packages/board/src/scenes)
sealMasks().forEach((png, i) => writeFileSync(`dist/seal-${i === 0 ? "grain" : "edge"}.png`, png));
for (const f of ["ink-light.svg", "ink-dark.svg"]) copyFileSync(`../../packages/board/src/scenes/${f}`, `dist/${f}`);
// the board's fonts (packages/board/src/fonts.css), the ones the two looks set text in, as TTF for Core Text (woff2 is a web
// container; the app registers dist/fonts at launch, Theme.swift): the code font, the serif of Ink Wash's titles and Notes,
// the handwriting of Marks (Shantell Sans, Yozai for its Chinese) and of Ink Wash's Section titles (Zhi Mang Xing)
const FONTS = "../../packages/board/src/fonts";
mkdirSync("dist/fonts", { recursive: true });
const fontFiles = [
  "JetBrainsMono-400-600.woff2",
  "JetBrainsMono-400i.woff2",
  "SourceSerif4-400-600.woff2",
  "SourceSerif4-400i.woff2",
  "ShantellSans-300-800.woff2",
]
  .concat(
    readdirSync(`${FONTS}/yozai`)
      .filter((f) => f.endsWith(".woff2"))
      .map((f) => `yozai/${f}`),
  )
  .concat(
    readdirSync(`${FONTS}/zhimangxing`)
      .filter((f) => f.endsWith(".woff2"))
      .map((f) => `zhimangxing/${f}`),
  );
for (const f of fontFiles) {
  const src = `${FONTS}/${f}`,
    out = `dist/fonts/${basename(f, ".woff2")}.ttf`;
  let fresh = false;
  try {
    fresh = statSync(out).mtimeMs >= statSync(src).mtimeMs;
  } catch {}
  if (!fresh) writeFileSync(out, await decompress(readFileSync(src)));
}
// the tree-sitter runtime and grammars (the analysis package's), read by the bridge from the app's Resources (js/highlight.ts)
const req = createRequire(import.meta.url);
for (const w of [
  "@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
  "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm",
  "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm",
  "@yhnocoder/tree-sitter-cuda/tree-sitter-cuda.wasm",
])
  copyFileSync(req.resolve(w), `dist/${basename(w)}`);
const common = {
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  target: "safari18",
  minify: false,
  sourcemap: false,
  logLevel: "info",
  define: { "import.meta.env.DEV": "false" },
  // the tree-sitter runtime's Node branches (never taken in JavaScriptCore: no `process`) name Node's modules
  external: ["url", "fs", "fs/promises", "path", "module", "vm", "worker_threads"],
  logOverride: { "empty-import-meta": "silent" },
};
await build({ ...common, entryPoints: ["js/entry.ts"], outfile: "dist/bridge.js", bundle: true });
// the routing alone, for the shell's background context (RouteWorker.swift)
await build({ ...common, entryPoints: ["js/router-entry.ts"], outfile: "dist/router.js", bundle: true });
