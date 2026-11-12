// Bundles the Note page (src/) with the Markdown package's build and the board's stylesheets into dist/, which the app
// loads from file URLs. dist/build-id is a hash of everything in it: Note snapshots drawn by another build are not reused.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [join(here, "src/page.ts")],
  bundle: true,
  format: "iife",
  target: "safari18",
  outdir: out,
  entryNames: "page",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".svg": "file" },
  assetNames: "assets/[name]-[hash]",
  minify: true,
  logLevel: "warning",
});
copyFileSync(join(here, "src/page.html"), join(out, "page.html"));
const hash = createHash("sha256");
for (const f of readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())) {
  const path = join(f.parentPath, f.name);
  hash.update(path.slice(out.length)).update(readFileSync(path));
}
writeFileSync(join(out, "build-id"), hash.digest("hex"));
console.log("built", out);
