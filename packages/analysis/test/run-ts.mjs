// Bundles one of the scripts in this folder to run under Node: node test/run-ts.mjs <script name> [args…]
// Relative paths in args are resolved against the directory npm was started from.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const [name, ...args] = process.argv.slice(2);
const out = path.join(here, `../../../test-out/${name}.mjs`);
await build({ entryPoints: [path.join(here, `${name}.ts`)], bundle: true, platform: "node", format: "esm", outfile: out, external: ["@vscode/tree-sitter-wasm"], logLevel: "error" });
execFileSync("node", [out, ...args], { stdio: "inherit", cwd: process.env.INIT_CWD ?? process.cwd() });
