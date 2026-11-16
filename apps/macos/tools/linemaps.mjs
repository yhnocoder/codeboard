#!/usr/bin/env node
// The line anchors' cases and what core's mapLines (packages/core/src/diff.ts, fuzzy) makes of them, for CodeCore's
// LineAnchors to match (the better-swift-markdown package's Tests/CodeCoreTests/LineAnchorsTests.swift):
//   node apps/macos/tools/linemaps.mjs > ../better-swift-markdown/Tests/CodeCoreTests/Fixtures/linemaps.json
import { mapLines } from "../../../packages/core/src/diff.ts";

// a fixed generator: the same cases every run
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const words = ["x", "ids", "batch", "step", "model", "run", "out", "self", "n", "barrier", "等待", "缓存", "café", "naïve", "_k2", "0", "42"];
const line = () => {
  const indent = pick(["", "    ", "        ", "\t", "\t\t"]);
  const kind = rand();
  if (kind < 0.1) return pick(["", "  ", "　", "\t"]);
  if (kind < 0.2) return indent + "# " + pick(words) + " " + pick(words) + " 注释";
  if (kind < 0.3) return indent + "return " + pick(words);
  const n = 1 + Math.floor(rand() * 4);
  return indent + Array.from({ length: n }, () => pick(words)).join(pick([" = ", "(", ", ", ".", " + "])) + pick(["", ")", ":", " {"]);
};
const edit = (a) => {
  const b = a.slice();
  const k = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < k; i++) {
    const at = Math.floor(rand() * (b.length + 1));
    const r = rand();
    if (r < 0.25) b.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, line));
    else if (r < 0.45 && b.length) b.splice(Math.min(at, b.length - 1), 1 + Math.floor(rand() * 2));
    else if (r < 0.75 && b.length) {
      // a word changed, or one added: still similar
      const j = Math.min(at, b.length - 1);
      b[j] = rand() < 0.5 ? b[j].replace(/[A-Za-z_]\w*/, pick(words)) : b[j] + " " + pick(words);
    } else if (r < 0.85 && b.length) b.splice(at, 0, b[Math.floor(rand() * b.length)]);
    else if (b.length > 2) {
      // a line moved
      const [moved] = b.splice(Math.floor(rand() * b.length), 1);
      b.splice(Math.floor(rand() * (b.length + 1)), 0, moved);
    }
  }
  return b;
};

const cases = [
  { a: [], b: ["x"] },
  { a: ["x"], b: [] },
  { a: ["a", "b", "c"], b: ["a", "b", "c"] },
  { a: ["def f():", "    return 1"], b: ["def g():", "    return 2", "    pass"] },
  { a: ["x = 1", "x = 1", "y"], b: ["x = 1", "y", "x = 1"] },
  { a: ["等待 一", "缓存 二"], b: ["等待 三", "缓存 二"] },
  { a: ["café = 1"], b: ["café = 2"] },
  { a: ["", "　"], b: ["\t", " "] },
  { a: ["a", "b", "c", "d"], b: ["q", "r", "s", "t"] },
  { a: ["one two three", "four"], b: ["zero", "one two three four"] },
];
for (let i = 0; i < 240; i++) {
  const a = Array.from({ length: Math.floor(rand() * 14) }, line);
  cases.push({ a, b: edit(a) });
}
const out = cases.map(({ a, b }, i) => {
  const aStart = 1 + (i % 3) * 10;
  const bStart = 1 + (i % 2) * 7;
  const m = mapLines(a, aStart, b, bStart, true);
  return { a, aStart, b, bStart, map: [...m.entries()].sort((x, y) => x[0] - y[0]) };
});
process.stdout.write(JSON.stringify(out) + "\n");
