// The scenarios run the host's code from core (ES modules) and from the extension (a CommonJS package), which Playwright's own
// loader can't mix, so the config first bundles them with esbuild into test-out/harness/specs/, one file per scenario file with
// the shared code split out (one harness and one set of fixtures per worker); Playwright runs those bundles as they are.
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSync } from "esbuild";
import { defineConfig } from "@playwright/test";
import { CHROMIUM, CHROMIUM_ARGS } from "./test/chromium";

const here = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(here, "../..");
const SPECS = path.join(REPO, "test-out/harness/specs");
const scenarios = path.join(here, "test/scenarios");

// the runner bundles; its workers (TEST_WORKER_INDEX) load the config again and use what it built
if (!process.env.TEST_WORKER_INDEX) {
  fs.rmSync(SPECS, { recursive: true, force: true }); // no bundle of a scenario file that is gone
  buildSync({
    entryPoints: [path.join(scenarios, "*.spec.ts")], outdir: SPECS, outbase: scenarios, outExtension: { ".js": ".mjs" }, chunkNames: "chunks/[name]-[hash]",
    bundle: true, splitting: true, format: "esm", platform: "node", target: "node22", sourcemap: true, logLevel: "error",
    external: ["@playwright/test", "playwright-core", "@vscode/tree-sitter-wasm"],
    define: { REPO_ROOT: JSON.stringify(REPO) },
    // CommonJS idioms in the bundled code: require() of Node's built-ins, __dirname (the bundle's, as in a CommonJS bundle)
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __filename.slice(0, __filename.lastIndexOf("/"));' },
  });
}

export default defineConfig({
  testDir: SPECS,
  testMatch: "*.spec.mjs",
  // already built: Playwright's own transform would only cost time (and shift the offsets coverage maps through the bundles' maps)
  build: { external: [path.join(SPECS, "**")] },
  outputDir: path.join(REPO, "test-out/harness/results"),
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  // the slowest scenarios take about 3 minutes on CI
  timeout: 6 * 60e3,
  reporter: "list",
  // Playwright's library defaults (30 s per action), which the scenarios are written for: some wait for an element that may
  // never come and go on when the wait times out
  use: { launchOptions: { executablePath: CHROMIUM, args: CHROMIUM_ARGS }, actionTimeout: 30e3, navigationTimeout: 30e3 },
});
