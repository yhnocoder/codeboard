// Builds the look tools' reference page (page.ts: Notes drawn by the Markdown package's editor with the board's
// stylesheets) into apps/macos/.build-look/page/page.html. Needs the Markdown package's build
// (npm run build -w @yhnocoder/markdown). Run by styles.mjs and look.mjs.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
export const pageDir = join(here, "../../../.build-look/page");

export async function buildPage() {
  mkdirSync(pageDir, { recursive: true });
  await build({
    entryPoints: [join(here, "page.ts")],
    bundle: true,
    format: "iife",
    target: "safari18",
    outdir: pageDir,
    entryNames: "page",
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".svg": "file" },
    assetNames: "assets/[name]-[hash]",
    logLevel: "warning",
  });
  copyFileSync(join(here, "page.html"), join(pageDir, "page.html"));
  return join(pageDir, "page.html");
}

if (import.meta.main) console.log("built", await buildPage());
