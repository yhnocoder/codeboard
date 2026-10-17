// Bundles perf-host.ts (with a Node Workspace, no vscode) to run under Node. Usage: node run-perf-host.mjs [--cards 240] [--runs 3]
// --index: the name index bench instead (perf-index.ts): node run-perf-host.mjs --index [--files 12000]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const name = process.argv.includes("--index") ? "perf-index" : "perf-host";
const out = path.join(here, `../../../test-out/${name}.cjs`);
await build({ entryPoints: [path.join(here, `${name}.ts`)], bundle: true, platform: "node", format: "cjs", outfile: out, external: ["@vscode/tree-sitter-wasm"], logLevel: "error" });
execFileSync("node", [out, ...process.argv.slice(2)], { stdio: "inherit" });
