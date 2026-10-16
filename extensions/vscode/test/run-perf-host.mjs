// Bundles perf-host.ts (with a fake vscode) to run under Node. Usage: node run-perf-host.mjs [--cards 240] [--runs 3]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "../../../test-out/perf-host.cjs");
await build({ entryPoints: [path.join(here, "perf-host.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, alias: { vscode: path.join(here, "vscode-stub.ts") }, external: ["@vscode/tree-sitter-wasm"], logLevel: "error" });
execFileSync("node", [out, ...process.argv.slice(2)], { stdio: "inherit" });
