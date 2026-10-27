import { build, context } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// tree-sitter 的运行时和 Python / C++ / Rust 语法（wasm）拷进 dist/，插件启动时 initAnalysis(dist)
const require = createRequire(import.meta.url);
const wasmDir = dirname(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm"));
mkdirSync("dist", { recursive: true });
for (const f of ["tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-cpp.wasm", "tree-sitter-rust.wasm"]) copyFileSync(join(wasmDir, f), join("dist", f));
// ELK（Tidy Up 的排版）放在 dist/elk.js，第一次 Tidy Up 才 require：打进 extension.js 的话，插件每次启动都要多解析 3.5 MB（约 80 ms）
copyFileSync(require.resolve("elkjs/lib/elk.bundled.js"), join("dist", "elk.js"));
const elkApart = { name: "elk-apart", setup: (b) => b.onResolve({ filter: /^elkjs\// }, () => ({ path: "./elk.js", external: true })) };

// 构建自哪个提交（Copy Diagnostics 里显示）：正好在发版 tag v<version> 上是正式版，什么都不加；否则写 "dev <短 commit>"，有没提交的改动再加 "dirty"
function buildId() {
  const run = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  const head = run("rev-parse", "--short", "HEAD");
  if (!head) return "";
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  if (run("tag", "--points-at", "HEAD").split("\n").includes(`v${version}`)) return "";
  return `dev ${head}${run("status", "--porcelain", "--untracked-files=no") ? " dirty" : ""}`;
}

const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  plugins: [elkApart],
  sourcemap: true,
  logLevel: "info",
  // core/analysis 里 import.meta.resolve 只在没给 wasm 目录时用（vitest）；打包后用不到
  define: { "import.meta.resolve": "undefined", __CODEBOARD_BUILD__: JSON.stringify(buildId()) },
};
if (process.argv.includes("--watch")) await (await context(opts)).watch();
else await build(opts);
