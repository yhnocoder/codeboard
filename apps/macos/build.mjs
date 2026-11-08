// Bundles the JavaScript side for JavaScriptCore: one IIFE, no Node, no DOM (apps/macos/build.sh runs it, then builds the Swift app),
// and writes the board's colour tokens (themes.mjs) for Theme.swift
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { build } from "esbuild";
import { themes } from "./themes.mjs";

mkdirSync("dist", { recursive: true });
writeFileSync("dist/themes.json", JSON.stringify(themes()));
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
