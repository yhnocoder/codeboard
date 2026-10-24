// @codeboard/markdown stands on its own: its code and the example that uses it (examples/markdown-demo) import only npm packages and
// their own files, never the board, the host, core, the VS Code extension or vscode, and depend on no other @codeboard package. This is
// the one check for the package (packages/host/test/boundary.test.ts covers host and board). What the board adds comes in through
// options and setters
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../..");
// import … from "x", import "x", import("x") / import(`x`), require("x"); in CSS @import "x" and @import url(x) (quoted or not)
const JS_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'`])([^"'`]+)\1/gm;
const CSS_SPEC = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/g;
const specifiers = (text: string) => [...[...text.matchAll(JS_SPEC)].map((m) => m[2]), ...[...text.matchAll(CSS_SPEC)].map((m) => m[1])];
const FORBIDDEN = (s: string) => /^(@codeboard\/(board|host|core)|codeboard-vscode|vscode)(\/|$)/.test(s) || /(^|\/)extensions\//.test(s);
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : files(p);
  return /\.(ts|tsx|js|mjs|cjs|css|html)$/.test(e.name) ? [p] : [];
});
/** Imports in the files under dirs (relative to the repo) that leave root or name a forbidden package: "file: specifier" */
function bad(root: string, dirs: string[]) {
  const out: string[] = [];
  const under = (d: string) => { const p = path.join(REPO, d); return !fs.existsSync(p) ? [] : fs.statSync(p).isDirectory() ? files(p) : [p]; };
  // this file is skipped: its samples of forbidden imports are only strings
  for (const f of dirs.flatMap(under).filter((f) => f !== __filename)) {
    for (const s of specifiers(fs.readFileSync(f, "utf8"))) {
      const outside = s.startsWith(".") && path.relative(path.join(REPO, root), path.resolve(path.dirname(f), s)).startsWith("..");
      if (outside || FORBIDDEN(s)) out.push(`${path.relative(REPO, f)}: ${s}`);
    }
  }
  return out;
}
/** @codeboard/* packages a package.json depends on (any kind of dependency) */
const codeboardDeps = (pkg: string) => {
  const j = JSON.parse(fs.readFileSync(path.join(REPO, pkg, "package.json"), "utf8"));
  return [j.dependencies, j.devDependencies, j.peerDependencies, j.optionalDependencies].flatMap((d) => Object.keys(d ?? {})).filter((n) => n.startsWith("@codeboard/")).sort();
};

describe("markdown package boundaries", () => {
  it("the scan sees every way of importing", () => {
    const text = [
      'import { a } from "@codeboard/core";', 'import "vscode";', 'const m = await import("../../board/src/x");', "const t = import(`@codeboard/host/${n}`);",
      'const r = require("codeboard-vscode");', '@import "../../../extensions/vscode/a.css";', "@import url(../../board/src/styles.css);", '@import url("@codeboard/board/x.css");',
    ].join("\n");
    expect(specifiers(text)).toEqual(["@codeboard/core", "vscode", "../../board/src/x", "@codeboard/host/${n}", "codeboard-vscode", "../../../extensions/vscode/a.css", "../../board/src/styles.css", "@codeboard/board/x.css"]);
    expect(specifiers(text).filter((s) => FORBIDDEN(s) || s.startsWith("../../"))).toHaveLength(8);
  });
  it("packages/markdown imports nothing from the board, host, core or the extension", () => {
    expect(bad("packages/markdown", ["packages/markdown/src", "packages/markdown/test"])).toEqual([]);
    expect(codeboardDeps("packages/markdown")).toEqual([]);
  });
  it("the example uses only @codeboard/markdown", () => {
    expect(bad("examples/markdown-demo", ["examples/markdown-demo/src", "examples/markdown-demo/test", "examples/markdown-demo/index.html"])).toEqual([]);
    expect(codeboardDeps("examples/markdown-demo")).toEqual(["@codeboard/markdown"]);
  });
});
