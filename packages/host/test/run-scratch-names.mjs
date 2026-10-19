// Bundles scratch-names.ts to run in Node (no vscode). Usage: node run-scratch-names.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "../../../test-out/scratch-names.cjs");
await build({ entryPoints: [path.join(here, "scratch-names.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error" });
execFileSync("node", [out], { stdio: "inherit" });
