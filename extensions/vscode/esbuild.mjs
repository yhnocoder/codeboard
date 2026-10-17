import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// tree-sitter 的运行时和 Python / C++ / Rust 语法（wasm）拷进 dist/，插件启动时 initAnalysis(dist)
const require = createRequire(import.meta.url);
const wasmDir = dirname(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm"));
mkdirSync("dist", { recursive: true });
for (const f of ["tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-cpp.wasm", "tree-sitter-rust.wasm"]) copyFileSync(join(wasmDir, f), join("dist", f));

const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
  // core/analysis 里 import.meta.resolve 只在没给 wasm 目录时用（vitest）；打包后用不到
  define: { "import.meta.resolve": "undefined" },
};
if (process.argv.includes("--watch")) await (await context(opts)).watch();
else await build(opts);
