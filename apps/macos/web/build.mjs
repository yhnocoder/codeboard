// Builds what the Mac app carries besides its code into dist/, which the app reads from Contents/Resources/Assets
// (and `swift run` / `swift test` from here): the formula and diagram engines the native Markdown renderer runs in
// JavaScriptCore (engines.js), the board's fonts and backdrops (assets/<name>-<hash>.<ext>, the names the canvas looks
// fonts up by), the fonts' licences, and the page that rasterizes SVG image cards (svg.html). dist/build-id is a hash
// of everything in it: SVG pictures drawn by another build are not reused.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const board = join(here, "../../../packages/board");
const out = join(here, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });
await build({
  entryPoints: [join(here, "src/engines.ts")],
  bundle: true,
  format: "iife",
  target: "safari18",
  outfile: join(out, "engines.js"),
  minify: true,
  logLevel: "warning",
});
copyFileSync(join(here, "src/svg.html"), join(out, "svg.html"));
/** a file under assets/ as `<name>-<first 8 of its hash>.<ext>` */
function asset(file) {
  const data = readFileSync(file);
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 8).toUpperCase();
  const ext = extname(file);
  writeFileSync(join(out, "assets", `${basename(file, ext)}-${hash}${ext}`), data);
}
for (const e of readdirSync(join(board, "src/fonts"), { recursive: true, withFileTypes: true }))
  if (e.isFile() && e.name.endsWith(".woff2")) asset(join(e.parentPath, e.name));
for (const f of readdirSync(join(board, "src/scenes")).filter((n) => n.endsWith(".svg"))) asset(join(board, "src/scenes", f));
// the board's fonts ship under the SIL Open Font License, whose text travels with them
const licences = join(board, "public/fonts");
mkdirSync(join(out, "fonts"));
for (const f of readdirSync(licences).filter((n) => n.endsWith(".txt"))) copyFileSync(join(licences, f), join(out, "fonts", f));
const hash = createHash("sha256");
for (const f of readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())) {
  const path = join(f.parentPath, f.name);
  hash.update(path.slice(out.length)).update(readFileSync(path));
}
writeFileSync(join(out, "build-id"), hash.digest("hex"));
console.log("built", out);
