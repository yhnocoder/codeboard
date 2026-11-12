#!/usr/bin/env node
// The look comparison (CONTRIBUTING.md, apps/macos): the fixture board in storage/ drawn by the real web board and by the Mac
// canvas's drawing code, in every theme, side by side. Output in apps/macos/.build-look/ (git-ignored):
// <theme>/board.png (the whole board) and <theme>/<card>@<zoom>.png (web | Swift | difference).
//   node apps/macos/tools/look/compare.mjs [--skip-build] [--swift-only]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const repo = path.resolve(here, "../../../..");
const mac = path.join(repo, "apps/macos");
const out = path.join(mac, ".build-look");
const args = new Set(process.argv.slice(2));
const run = (cmd, a, cwd = repo) => execFileSync(cmd, a, { cwd, stdio: "inherit" });

if (!args.has("--skip-build") && !args.has("--swift-only")) {
  run("npm", ["run", "build", "-w", "@yhnocoder/markdown"]);
  run("npm", ["run", "build", "-w", "@codeboard/board"]);
  run("node", ["apps/macos/web/build.mjs"]);
}
if (!args.has("--swift-only")) {
  fs.rmSync(out, { recursive: true, force: true });
  const bundle = path.join(out, "reference.mjs");
  await build({
    entryPoints: [path.join(here, "reference.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: "warning",
    plugins: [
      {
        name: "npm-external",
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, (r) =>
            r.path.startsWith("@codeboard/") || r.path.startsWith("node:") ? undefined : { external: true },
          );
        },
      },
    ],
  });
  // the bundle imports npm packages from the repo's node_modules
  const { reference } = await import(bundle);
  await reference({
    storage: path.join(here, "storage"),
    boardDist: path.join(repo, "packages/board/dist"),
    page: here,
    out,
    themes: ["warm-ink", "ink-wash"],
  });
}
run("swift", ["run", "-c", "release", "LookCompare", path.join(here, "storage"), out], mac);
