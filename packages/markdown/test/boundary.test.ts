// @codeboard/markdown stands on its own: its code and the example that uses it (examples/markdown-demo) import only npm packages and
// their own files, never the board, the host, core, the VS Code extension or vscode. What the board adds comes in through options and setters
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../..");
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|@import\s+)["']([^"']+)["']/gm;
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : files(p);
  return /\.(ts|tsx|js|mjs|cjs|css|html)$/.test(e.name) ? [p] : [];
});
/** Imports in the files under dirs (relative to the repo) that leave root or name a forbidden package: "file: specifier" */
function bad(root: string, dirs: string[]) {
  const out: string[] = [];
  const under = (d: string) => { const p = path.join(REPO, d); return !fs.existsSync(p) ? [] : fs.statSync(p).isDirectory() ? files(p) : [p]; };
  for (const f of dirs.flatMap(under)) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(SPEC)) {
      const s = m[1];
      const outside = s.startsWith(".") && path.relative(path.join(REPO, root), path.resolve(path.dirname(f), s)).startsWith("..");
      if (outside || /^(@codeboard\/(board|host|core)|codeboard-vscode|vscode)(\/|$)/.test(s) || /(^|\/)extensions\//.test(s)) out.push(`${path.relative(REPO, f)}: ${s}`);
    }
  }
  return out;
}

describe("markdown package boundaries", () => {
  it("packages/markdown imports nothing from the board, host, core or the extension", () => {
    expect(bad("packages/markdown", ["packages/markdown/src", "packages/markdown/test"])).toEqual([]);
  });
  it("the example uses only @codeboard/markdown", () => {
    expect(bad("examples/markdown-demo", ["examples/markdown-demo/src", "examples/markdown-demo/test", "examples/markdown-demo/index.html"])).toEqual([]);
  });
});
