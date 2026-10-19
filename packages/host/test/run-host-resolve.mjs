// Bundles host-resolve.ts (with a Node Workspace, no vscode) to run in Node: host expand / preview / variable candidates without a language service. Usage: node run-host-resolve.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "../../../test-out/host-resolve.cjs");
await build({ entryPoints: [path.join(here, "host-resolve.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, external: ["@vscode/tree-sitter-wasm"], logLevel: "error" });
execFileSync("node", [out], { stdio: "inherit" });
