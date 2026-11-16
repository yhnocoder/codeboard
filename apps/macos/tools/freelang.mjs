#!/usr/bin/env node
// Pieces of the repository's own sources and what core's guessLang (with pythonDialect, as a Free code card's language
// is guessed: page.ts lang) makes of each, for CodeBoardModel's FreeLanguage to match (Tests/CodeBoardModelTests/
// FreeLanguageTests.swift):
//   node apps/macos/tools/freelang.mjs > apps/macos/Tests/CodeBoardModelTests/Fixtures/freelang.json
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { guessLang, pythonDialect } from "../../../packages/core/src/paste.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(py|rs|sh|c|h|cu|cpp|mjs|ts|swift|md|json|yml)$/.test(f) && !f.includes("Fixtures"))
  .sort();
// a fixed generator: the same pieces every run
let seed = 11;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const texts = [
  "",
  "   \n\t",
  "x = 1",
  "foo(bar)",
  "Two things to note:",
  "等待 = 1",
  "import triton\n@triton.jit\ndef k(x):\n    tl.load(x)",
  "import tilelang\nT.Kernel(1)",
  "$ ls -la",
];
while (texts.length < 400) {
  const lines = fs.readFileSync(path.join(root, pick(files)), "utf8").split("\n");
  const n = 1 + Math.floor(rand() * 14);
  const at = Math.floor(rand() * Math.max(1, lines.length - n));
  texts.push(lines.slice(at, at + n).join("\n"));
}
const lang = (t) => {
  const g = guessLang(t);
  return g === "python" ? pythonDialect(t) : g;
};
console.log(JSON.stringify(texts.map((text) => ({ text, lang: lang(text) }))));
