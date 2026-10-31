// The VS Code e2e scripts (extensions/vscode/test/*.cjs) follow the same rules through their own helpers in wait.cjs: until / idle,
// and hold(ms, why) with a named constant for the fixed waits
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST = fileURLToPath(new URL("..", import.meta.url));
const files = () => [
  ...fs
    .readdirSync(path.join(TEST, "scenarios"))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `scenarios/${f}`),
  "harness.ts",
  "subhost.ts",
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
  [
    "scenarios/chains.spec.ts",
    "await new Promise((r) => setTimeout(r, 1500));",
    "a slow language service in the fake host: the board must show it is waiting",
  ],
  [
    "scenarios/codeedit.spec.ts",
    "await new Promise((r) => setTimeout(r, 30));",
    "the fake language service answers completions a little late, as a real one does",
  ],
  [
    "scenarios/mdreview.spec.ts",
    "Promise.race([navigator.clipboard.readText(), new Promise",
    "a bound on reading the clipboard (clip-cut, clip-copy-paste), not a wait",
  ],
  [
    "scenarios/mdreview.spec.ts",
    "Promise.race([navigator.clipboard.writeText(",
    "a bound on writing the clipboard (paste-shift-plain), not a wait",
  ],
];

type Hit = { at: string; line: string; match: string };
const scan = (file: string, text: string): Hit[] => {
  const src = text.replace(/^[ \t]*(\/\/|\/?\*).*$/gm, (m) => " ".repeat(m.length)); // whole-line comments blanked, line numbers kept
  const lines = text.split("\n");
  const out: Hit[] = [];
  for (const re of RULES)
    for (const m of src.matchAll(re)) {
      const n = src.slice(0, m.index).split("\n").length;
      out.push({ at: `${file}:${n}`, line: lines[n - 1], match: m[0].replace(/\s+/g, " ").trim() });
    }
  return out;
};

/** Each call re matches (its first group = the arguments, which may span lines), outside whole-line comments */
const callsIn = (text: string, re: RegExp) => {
  const src = text.replace(/^[ \t]*(\/\/|\/?\*).*$/gm, (m) => " ".repeat(m.length));
  return [...src.matchAll(re)].map((m) => ({
    line: lineOf(src, m.index),
    args: m[1],
    text: m[0].replace(/\s+/g, " ").trim(),
  }));
};

describe("harness scenarios wait for state, not for time", () => {
  it("no scenario sleeps except through hold(h, ms, why)", () => {
    const bad: string[] = [];
    const used = new Set<number>();
    for (const f of files()) {
      for (const h of scan(f, fs.readFileSync(path.join(TEST, f), "utf8"))) {
        const i = ALLOW.findIndex(([af, snip]) => af === f && h.line.includes(snip));
        if (i < 0) bad.push(`${h.at}: ${h.match}`);
        else used.add(i);
      }
    }
    expect(bad).toEqual([]);
    expect(ALLOW.filter((_, i) => !used.has(i)).map(([f, snip]) => `${f}: ${snip}`)).toEqual([]);
  });

  it("every hold says why, and the fixed waits are counted", () => {
    const holds: string[] = [],
      focus: string[] = [],
      bare: string[] = [];
    for (const f of files()) {
      const text = fs.readFileSync(path.join(TEST, f), "utf8");
      for (const c of callsIn(text, /\bhold\s*\(([^)]*)/g)) {
        holds.push(`${f}:${c.line}`);
        if (!/^[^,]+,[^,]+,\s*["'`]\s*[^"'`\s]/.test(c.args)) bare.push(`${f}:${c.line}: ${c.text}`);
      }
      for (const c of callsIn(text, /\bfocusSettled\s*\(()/g)) focus.push(`${f}:${c.line}`);
    }
    console.log(
      `fixed waits in the harness scenarios: ${holds.length} hold() sites, ${focus.length} focusSettled() sites (grep -n "hold(\\|focusSettled(" packages/board/test/scenarios)`,
    );
    expect(bare).toEqual([]);
    expect(holds.length).toBeGreaterThan(0);
  });

  it("catches the shapes it is meant to catch", () => {
    const hits = scan(
      "x.ts",
      [
        "await page.waitForTimeout(300);",
        "await new Promise((r) => setTimeout(r, 500));",
        "await new Promise<void>(res => { setTimeout(res, 50); });",
        'import { setTimeout as sleep } from "node:timers/promises";',
        "const wait = (h: Host, ms: number) => h.page.waitForTimeout(ms);",
        "// await page.waitForTimeout(300) in a comment",
        'await new Promise((r) => setTimeout(r, 0)); await hold(h, DBL_CLICK, "two single clicks");',
        "infoT = setTimeout(() => void pushInfo(), 60); const waited = 1;",
      ].join("\n"),
    );
    expect(hits.map((h) => h.at.split(":")[1]).sort((a, b) => +a - +b)).toEqual(["1", "2", "3", "4", "5", "5"]);
  });
});

const E2E = path.join(TEST, "../../../extensions/vscode/test");
const e2eFiles = () => fs.readdirSync(E2E).filter((f) => /\.c?js$/.test(f));
/** wait.cjs's poll step: the one timer the e2e scripts wait on, inside until / soon / idle / hold */
const E2E_ALLOW: [string, string][] = [["wait.cjs", "const tick = (ms) => new Promise((r) => setTimeout(r, ms));"]];
/** A click or wait whose failure is swallowed: .catch(() => {}) with nothing in it */
const SWALLOW = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/g;
const lineOf = (text: string, i: number) => text.slice(0, i).split("\n").length;

describe("VS Code e2e scripts wait for state, not for time", () => {
  it("no e2e script sleeps or swallows a failed wait", () => {
    const bad: string[] = [];
    let allowed = 0;
    for (const f of e2eFiles()) {
      const text = fs.readFileSync(path.join(E2E, f), "utf8");
      const swallowed = [...text.matchAll(SWALLOW)].map((m) => ({
        at: `${f}:${lineOf(text, m.index)}`,
        line: "",
        match: m[0],
      }));
      for (const h of [...scan(f, text), ...swallowed]) {
        if (E2E_ALLOW.some(([af, snip]) => af === f && h.line.includes(snip))) allowed++;
        else bad.push(`${h.at}: ${h.match}`);
      }
    }
    expect(bad).toEqual([]);
    expect(allowed).toBe(E2E_ALLOW.length);
  });

  it("every e2e hold has a named time and says why, and they are counted", () => {
    const holds: string[] = [],
      bare: string[] = [];
    for (const f of e2eFiles()) {
      for (const c of callsIn(fs.readFileSync(path.join(E2E, f), "utf8"), /\bawait\s+hold\s*\(([^)]*)/g)) {
        // a hold that is not awaited would wait for nothing
        holds.push(`${f}:${c.line}`);
        // hold(<a named constant, not a bare number>, "<why>")
        if (!/^\s*[A-Za-z_][\w.]*\s*(?:[-+*]\s*[A-Za-z_][\w.]*\s*)*,\s*["'`]\s*[^"'`\s]/.test(c.args))
          bare.push(`${f}:${c.line}: ${c.text}`);
      }
    }
    console.log(`fixed waits in the VS Code e2e scripts: ${holds.length} hold() sites (${holds.join(", ")})`);
    expect(bare).toEqual([]);
  });

  it("catches a bare-number hold and a swallowed wait", () => {
    const t = 'await hold(300, "x");\nawait btn.click().catch(() => {});\nawait hold(timing.PEEK_DELAY, "no Peek");';
    expect([...t.matchAll(SWALLOW)].length).toBe(1);
    const ok = (args: string) => /^\s*[A-Za-z_][\w.]*\s*(?:[-+*]\s*[A-Za-z_][\w.]*\s*)*,\s*["'`]\s*[^"'`\s]/.test(args);
    expect([ok('300, "x"'), ok('timing.PEEK_DELAY, "no Peek"'), ok('QI_REFOCUS, ""')]).toEqual([false, true, false]);
  });
});
