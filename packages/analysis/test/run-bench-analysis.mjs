// Bundles bench-analysis.ts to run under Node. Usage: npm run bench:analysis -w @codeboard/analysis [-- <repository dir>]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "../../../test-out/bench-analysis.mjs");
await build({ entryPoints: [path.join(here, "bench-analysis.ts")], bundle: true, platform: "node", format: "esm", outfile: out, external: ["@vscode/tree-sitter-wasm"], logLevel: "error" });
execFileSync("node", [out, ...process.argv.slice(2).map((a) => path.resolve(process.env.INIT_CWD ?? process.cwd(), a))], { stdio: "inherit" });
