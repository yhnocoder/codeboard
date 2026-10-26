// Bundles gen.ts (it uses the harness's host code from core) to run under Node and writes code.json next to this file.
// Usage: node packages/board/stories/fixtures/gen.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, "../../../..");
const out = path.join(repo, "test-out/storybook-fixtures/gen.mjs");
await build({
  entryPoints: [path.join(here, "gen.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: out,
  external: ["playwright-core", "@vscode/tree-sitter-wasm"], logLevel: "warning",
  define: { REPO_ROOT: JSON.stringify(repo), OUT_FILE: JSON.stringify(path.join(here, "code.json")) },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
execFileSync("node", [out], { stdio: "inherit" });
