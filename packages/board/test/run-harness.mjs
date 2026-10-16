// Bundles scenarios.ts (with core and analysis) to run under Node. Usage: node run-harness.mjs <scenario…> [--light]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "../../../test-out/harness/run.cjs");
await build({ entryPoints: [path.join(here, "scenarios.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, external: ["playwright-core", "@vscode/tree-sitter-wasm"], logLevel: "warning" });
execFileSync("node", [out, ...process.argv.slice(2)], { stdio: "inherit" });
