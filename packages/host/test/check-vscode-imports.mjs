// Architecture guard: host code never imports "vscode"; editor access goes through the Workspace interface.
// Usage: node packages/host/test/check-vscode-imports.mjs (part of npm run test:host)
import * as fs from "node:fs";
import * as path from "node:path";

const src = path.join(path.dirname(new URL(import.meta.url).pathname), "../src");
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']vscode["']/m;

const bad = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && IMPORT.test(fs.readFileSync(p, "utf8"))) bad.push(path.relative(src, p));
  }
};
walk(src);
if (bad.length) {
  console.log(`✗ These host files import "vscode"; use the Workspace interface (src/ws.ts workspace()) instead:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ No host file imports "vscode"`);
