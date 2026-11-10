// Bundles the Note page (src/page.ts + the Markdown package's build) into dist/, which the app loads from file URLs.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "dist"), { recursive: true });
await build({
  entryPoints: [join(here, "src/page.ts")],
  bundle: true,
  format: "iife",
  target: "safari17",
  outdir: join(here, "dist"),
  entryNames: "page",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  assetNames: "fonts/[name]",
  minify: true,
  logLevel: "warning",
});
copyFileSync(join(here, "src/page.html"), join(here, "dist/page.html"));
console.log("built", join(here, "dist"));
