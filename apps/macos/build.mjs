// Bundles the JavaScript side for JavaScriptCore: one IIFE, no Node, no DOM (apps/macos/build.sh runs it, then builds the Swift app)
import { build } from "esbuild";

await build({
  entryPoints: ["js/entry.ts"],
  bundle: true,
  outfile: "dist/bridge.js",
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  target: "safari18",
  minify: false,
  sourcemap: false,
  logLevel: "info",
  define: { "import.meta.env.DEV": "false" },
});
