// The harness scenarios wait for real state, not for a fixed time: no scenario file (nor harness.ts / subhost.ts, which they run
// through) sleeps on its own. The waits are until / idle / Playwright's own; a wait that has to be a fixed time goes through
// hold(h, ms, why) (or focusSettled, ProseMirror's focus timers, which holds through it) in fixtures.ts, so that every one of them
// is named and counted. Checked by shape, like packages/core/test/edit.test.ts; prints how many hold sites there are
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST = fileURLToPath(new URL("..", import.meta.url));
const files = () => [
  ...fs.readdirSync(path.join(TEST, "scenarios")).filter((f) => /\.tsx?$/.test(f)).map((f) => `scenarios/${f}`),
  "harness.ts", "subhost.ts",
];

/** A sleep: Playwright's fixed wait, a Promise resolved by a timer, a timers/promises import, a file's own wait / sleep helper */
const RULES = [
  /\bwaitForTimeout\s*\(/g,
  /\bnew\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*\{?\s*(?:window\.)?setTimeout\s*\((?!\s*\w+\s*,\s*0\s*\))/g,
  /["'](?:node:)?timers\/promises["']/g,
  /\b(?:const|let|function)\s+(?:wait|sleep|delay|pause)\b/g,
];
/** Timers in a scenario that are not a scenario waiting: [file, a snippet of the line, why] */
const ALLOW: [string, string, string][] = [
  ["scenarios/chains.spec.ts", "W.language.implementations = async", "a slow language service in the fake host: the board must show it is waiting"],
  ["scenarios/codeedit.spec.ts", "await new Promise((r) => setTimeout(r, 30));", "the fake language service answers completions a little late, as a real one does"],
  ["scenarios/mdreview.spec.ts", "name: \"clip-cut\"", "a bound on reading the clipboard (Promise.race), not a wait"],
  ["scenarios/mdreview.spec.ts", "name: \"clip-copy-paste\"", "a bound on reading the clipboard (Promise.race), not a wait"],
  ["scenarios/mdreview.spec.ts", "name: \"paste-shift-plain\"", "a bound on writing the clipboard (Promise.race), not a wait"],
];

type Hit = { at: string; line: string; match: string };
const scan = (file: string, text: string): Hit[] => {
  const src = text.replace(/^[ \t]*(\/\/|\/?\*).*$/gm, (m) => " ".repeat(m.length)); // whole-line comments blanked, line numbers kept
  const lines = text.split("\n");
  const out: Hit[] = [];
  for (const re of RULES) for (const m of src.matchAll(re)) {
    const n = src.slice(0, m.index).split("\n").length;
    out.push({ at: `${file}:${n}`, line: lines[n - 1], match: m[0].replace(/\s+/g, " ").trim() });
  }
  return out;
};

describe("harness scenarios wait for state, not for time", () => {
  it("no scenario sleeps except through hold(h, ms, why)", () => {
    const bad: string[] = [];
    const used = new Set<number>();
    for (const f of files()) {
      for (const h of scan(f, fs.readFileSync(path.join(TEST, f), "utf8"))) {
        const i = ALLOW.findIndex(([af, snip]) => af === f && h.line.includes(snip));
        if (i < 0) bad.push(`${h.at}: ${h.match}`); else used.add(i);
      }
    }
    expect(bad).toEqual([]);
    expect(ALLOW.filter((_, i) => !used.has(i)).map(([f, snip]) => `${f}: ${snip}`)).toEqual([]);
  });

  it("every hold says why, and the fixed waits are counted", () => {
    const holds: string[] = [], focus: string[] = [], bare: string[] = [];
    for (const f of files()) {
      fs.readFileSync(path.join(TEST, f), "utf8").split("\n").forEach((t, i) => {
        if (/^\s*(\/\/|\/?\*)/.test(t)) return;
        for (const m of t.matchAll(/\bhold\s*\(([^)]*)/g)) {
          holds.push(`${f}:${i + 1}`);
          if (!/^[^,]+,[^,]+,\s*["'`]\s*\S/.test(m[1])) bare.push(`${f}:${i + 1}: ${t.trim()}`);
        }
        for (const _ of t.matchAll(/\bfocusSettled\s*\(/g)) focus.push(`${f}:${i + 1}`);
      });
    }
    console.log(`fixed waits in the harness scenarios: ${holds.length} hold() sites, ${focus.length} focusSettled() sites (grep -n "hold(\\|focusSettled(" packages/board/test/scenarios)`);
    expect(bare).toEqual([]);
    expect(holds.length).toBeGreaterThan(0);
  });

  it("catches the shapes it is meant to catch", () => {
    const hits = scan("x.ts", [
      "await page.waitForTimeout(300);",
      "await new Promise((r) => setTimeout(r, 500));",
      "await new Promise<void>(res => { setTimeout(res, 50); });",
      "import { setTimeout as sleep } from \"node:timers/promises\";",
      "const wait = (h: Host, ms: number) => h.page.waitForTimeout(ms);",
      "// await page.waitForTimeout(300) in a comment",
      "await new Promise((r) => setTimeout(r, 0)); await hold(h, DBL_CLICK, \"two single clicks\");",
      "infoT = setTimeout(() => void pushInfo(), 60); const waited = 1;",
    ].join("\n"));
    expect(hits.map((h) => h.at.split(":")[1]).sort((a, b) => +a - +b)).toEqual(["1", "2", "3", "4", "5", "5"]);
  });
});
