// Bundles perf.ts to run under Node. Usage: node run-perf.mjs [--cards 240] [--runs 3] [--json out.json]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "../../../test-out/harness/perf.cjs");
await build({
  entryPoints: [path.join(here, "perf.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  external: ["playwright-core", "@vscode/tree-sitter-wasm"],
  logLevel: "warning",
  define: { REPO_ROOT: JSON.stringify(path.resolve(here, "../../..")) },
});
execFileSync("node", [out, ...process.argv.slice(2)], { stdio: "inherit" });
