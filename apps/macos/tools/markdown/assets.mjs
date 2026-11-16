// Builds the board's fonts, which the Markdown component draws the board's looks with, into
// apps/macos/.build-markdown (assets/<name>-<first 8 of its hash>.woff2, the names MarkdownLooks looks them up
// by) with their licences. Tests, benches and the look tool read them from there; the app and the demo app
// carry them in their bundle (Contents/Resources/Assets). The formula and diagram engines are the
// better-swift-markdown package's, in its resource bundle
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const board = join(here, "../../../../packages/board");
const out = join(here, "../../.build-markdown");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });
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
