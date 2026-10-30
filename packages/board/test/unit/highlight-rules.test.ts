// Every ::highlight() rule in a stylesheet the board loads is scoped to the part of the page that uses it (".md-pm ::highlight(x)").
// An unscoped one (a bare "::highlight(x)") makes Chromium resolve a highlight style for every element of the page on every style
// recalc: the board's style work about doubles on every pan, zoom and card drag
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const require = createRequire(import.meta.url);

/** The selectors (one per comma) that name a ::highlight() pseudo-element */
function highlightSelectors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{/g)) for (const s of m[1].split(",")) if (s.includes("::highlight(")) out.push(s.trim());
  return out;
}

describe("stylesheets the board loads", () => {
  const sheets = [...walk(SRC).filter((f) => f.endsWith(".css")), require.resolve("@yhnocoder/markdown/style.css"), require.resolve("@yhnocoder/markdown/katex.css")];
  it("scope every ::highlight() rule to an ancestor", () => {
    const all = sheets.flatMap((f) => highlightSelectors(fs.readFileSync(f, "utf8")).map((s) => `${path.basename(f)}: ${s}`));
    expect(all.length).toBeGreaterThan(0); // the Note editor's find matches
    expect(all.filter((s) => !/\S\s+(\*\s*)?::highlight\(/.test(s.split(": ")[1]))).toEqual([]);
  });
  it("the check catches an unscoped rule", () => {
    expect(highlightSelectors("a { color: red } ::highlight(x), .p .q { color: red } .md-pm ::highlight(y) { color: red }")).toEqual(["::highlight(x)", ".md-pm ::highlight(y)"]);
  });
});
