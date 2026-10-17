// Architecture guard: only the VS Code adapter files may import "vscode"; host features go through the Workspace interface.
// Usage: node extensions/vscode/test/check-vscode-imports.mjs (part of npm run test:host)
import * as fs from "node:fs";
import * as path from "node:path";

const src = path.join(path.dirname(new URL(import.meta.url).pathname), "../src");
/** The VS Code shell: activation, webview panel, sidebar trees, CodeLens / gutter marks, command registration, and the Workspace adapter folder */
const ALLOW = new Set(["extension.ts", "panel.ts", "sidebar.ts", "lens.ts", "commands.ts"]);
const ADAPTER = "vscode/";
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']vscode["']/m;

const bad = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
      const rel = path.relative(src, p).split(path.sep).join("/");
      if (ALLOW.has(rel) || rel.startsWith(ADAPTER)) continue;
      if (IMPORT.test(fs.readFileSync(p, "utf8"))) bad.push(rel);
    }
  }
};
walk(src);
if (bad.length) {
  console.log(`✗ These host files import "vscode"; use the Workspace interface (src/ws.ts workspace()) instead:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ Only the VS Code adapter imports "vscode" (${[...ALLOW].join(", ")}, ${ADAPTER})`);
