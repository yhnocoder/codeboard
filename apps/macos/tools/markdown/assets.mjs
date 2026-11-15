// Builds what the Markdown component draws with besides its code into apps/macos/.build-markdown: the formula and
// diagram engines it runs in JavaScriptCore (engines.js: MathJax and pele, from engines.ts), and the board's fonts
// (assets/<name>-<first 8 of its hash>.woff2, the names MarkdownAssets looks them up by) with their licences. Tests,
// benches and the look tool read it from there; a host or the demo app carries it in its bundle (Contents/Resources/Assets)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const board = join(here, "../../../../packages/board");
const out = join(here, "../../.build-markdown");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });
await build({
  entryPoints: [join(here, "engines.ts")],
  bundle: true,
  format: "iife",
  target: "safari18",
  outfile: join(out, "engines.js"),
  minify: true,
  logLevel: "warning",
});
for (const e of readdirSync(join(board, "src/fonts"), { recursive: true, withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith(".woff2")) continue;
  const data = readFileSync(join(e.parentPath, e.name));
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 8).toUpperCase();
  const ext = extname(e.name);
  writeFileSync(join(out, "assets", `${basename(e.name, ext)}-${hash}${ext}`), data);
}
// the board's fonts ship under the SIL Open Font License, whose text travels with them
const licences = join(board, "public/fonts");
mkdirSync(join(out, "fonts"));
for (const f of readdirSync(licences).filter((n) => n.endsWith(".txt"))) copyFileSync(join(licences, f), join(out, "fonts", f));
console.log("built", out);
