// The host tests wait for real events, not for a fixed time, and don't time themselves by the wall clock: a promise the code under
// test resolves (watchVersions' ready), vitest's fake timers for the product's named delays (RECHECK_PAUSE, WARM_DELAY, RETRY_GAP),
// a stub the test releases, or vi.waitFor on the real state (its timeout is only a ceiling). Fixed sleeps made these tests slow and
// broke them on a loaded machine; checked by shape, like packages/board/test/unit/scenario-waits.test.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** A sleep (a Promise resolved by a timer, timers/promises, a file's own sleep helper) or a wall-clock time limit */
const RULES = [
  /\bnew\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(/g,
  /["'](?:node:)?timers\/promises["']/g,
  /\b(?:const|let|function)\s+(?:wait|sleep|delay|pause)\b/g,
  /\b(?:Date|performance)\.now\(\)\s*-\s*\w+\s*\)\s*\.toBeLessThan/g,
];

describe("host tests wait for events, not for time", () => {
  it("no host test sleeps or asserts wall-clock time", () => {
    const bad: string[] = [];
    for (const f of fs.readdirSync(__dirname).filter((f) => /\.test\.ts$|^helpers\.ts$/.test(f) && f !== "test-waits.test.ts")) {
      const text = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
      for (const re of RULES) for (const m of text.matchAll(re)) bad.push(`${f}:${text.slice(0, m.index).split("\n").length}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
