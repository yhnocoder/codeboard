// The CI reports built from the harness results: the PR description's CI section (tools/test/ci-report.mjs), passing alone
// counted and bounded (tools/test/alone.mjs) and shown in the regular report (tools/test/regular-report.mjs), and which changes
// run the perf job (tools/test/areas.mjs perfFiles, tiers.json "perf")
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { ciReport, harnessLines, withSection } from "../../../../tools/test/ci-report.mjs";
// @ts-expect-error plain ESM script without type declarations
import { ALONE_LIMIT, aloneStreaks, noAloneRetry } from "../../../../tools/test/alone.mjs";
// @ts-expect-error plain ESM script without type declarations
import { regularReport } from "../../../../tools/test/regular-report.mjs";
// @ts-expect-error plain ESM script without type declarations
import { perfFiles } from "../../../../tools/test/areas.mjs";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const TIERS = JSON.parse(fs.readFileSync(path.join(REPO, "packages/board/test/tiers.json"), "utf8"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-ci-report-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
/** An artifacts directory: { "harness-1/result.json": {...}, ... } */
function artifacts(name: string, files: Record<string, unknown>) {
  const dir = path.join(tmp, name);
  for (const [f, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), typeof v === "string" ? v : JSON.stringify(v));
  }
  return dir;
}
const ok = (name: string, why = "smoke") => ({ name, why, ok: true, ms: 1000, fails: [], known: [] });

describe("CI section of the PR description", () => {
  const dir = artifacts("pr", {
    "harness-plan/plan.json": {
      shards: 2,
      run: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "lost" }],
      deferred: ["later"],
      areas: [{ name: "canvas" }],
      notes: ["group canvas: 40 s, over the 30 s limit", "an internal note"],
    },
    "harness-1/result.json": {
      results: [ok("a"), { ...ok("b", "areas"), ok: false, fails: ["arrowsRoute: the arrow crosses the card\nmore"] }],
    },
    "harness-2/result.json": {
      results: [{ ...ok("c", "areas"), alone: true, parallelFails: ["idle: the board did not settle within 5000 ms"] }],
    },
    "perf/summary.md": "**Performance**: no regressions.",
    "e2e/audit.json": [],
  });
  const shots = path.join(dir, "shots.md");
  fs.writeFileSync(shots, "| shot | diff |");

  it("lists what ran, why, the failures, alone passes with their failure beside others, and missing results", () => {
    expect(harnessLines(dir)).toEqual([
      "**Harness**: 3 scenarios (1 smoke, 2 areas), 1 failed, on 2 of 2 jobs, 1 deferred to the regular run",
      "- ❌ b: arrowsRoute: the arrow crosses the card",
      "- ❌ picked but no result (a harness job failed before reporting): 1",
      "- ⚠️ c passed only when run alone; beside others: idle: the board did not settle within 5000 ms",
      "- area groups: canvas",
      "- ⚠️ group canvas: 40 s, over the 30 s limit",
      "",
      "<details><summary>Deferred (extra coverage that didn't fit)</summary>later</details>",
    ]);
  });
  it("says so when no harness job reported", () => {
    expect(harnessLines(artifacts("none", {}))).toEqual(["**Harness**: no results."]);
  });
  it("puts job results, harness, perf and screenshots between its markers", () => {
    const s = ciReport({
      dir,
      jobs: { unit: { result: "success" }, perf: { result: "skipped" }, e2e: { result: "failure" } },
      run: "https://ci/run/1",
      sha: "abc1234",
      shots,
    });
    expect(s.startsWith("<!-- ci-screenshots:start -->\n## CI report")).toBe(true);
    expect(s.endsWith("<!-- ci-screenshots:end -->")).toBe(true);
    expect(s).toContain("Commit abc1234 · [Run log](https://ci/run/1) · unit ✅ · perf – · e2e ❌");
    expect(s).toContain("**Performance**: no regressions.");
    expect(s).toContain("| shot | diff |");
  });
  it("without perf results or screenshots, says why", () => {
    const s = ciReport({ dir: artifacts("bare", {}), jobs: { perf: { result: "success" } }, run: "r", sha: "s" });
    expect(s).toContain("**Performance**: skipped, no change to code the benchmarks run.");
    expect(s).toContain("No screenshots.");
  });
  it("replaces the section in the description, or adds it at the end, keeping $ patterns as text", () => {
    const a = "<!-- ci-screenshots:start -->\nold\n<!-- ci-screenshots:end -->";
    const b = "<!-- ci-screenshots:start -->\ncost $& and $1\n<!-- ci-screenshots:end -->";
    expect(withSection(`Intro\n\n${a}\n\nTests: x`, b)).toBe(`Intro\n\n${b}\n\nTests: x`);
    expect(withSection("Intro", b)).toBe(`Intro\n\n${b}`);
    expect(withSection(null, b)).toBe(`\n\n${b}`);
  });
});

describe("passing alone, bounded", () => {
  it("counts the regular runs in a row a scenario passed only alone; passing or failing outright starts over", () => {
    const prev = { a: 2, b: 1, c: 1 };
    const results = [
      { name: "a", ok: true, alone: true },
      { name: "b", ok: true },
      { name: "c", ok: false },
      { name: "d", ok: true, alone: true },
    ];
    expect(aloneStreaks(prev, results)).toEqual({ a: 3, d: 1 });
    expect(aloneStreaks(undefined, results)).toEqual({ a: 1, d: 1 });
  });
  it("keeps a scenario without alone retries strict while it fails, until it passes beside the others", () => {
    const strict = { s: ALONE_LIMIT };
    const failed = aloneStreaks(strict, [{ name: "s", ok: false }]);
    expect(failed).toEqual({ s: ALONE_LIMIT });
    expect(noAloneRetry(failed)).toEqual(["s"]);
    expect(aloneStreaks(failed, [{ name: "s", ok: false }])).toEqual({ s: ALONE_LIMIT });
    const passed = aloneStreaks(failed, [{ name: "s", ok: true }]);
    expect(passed).toEqual({});
    expect(noAloneRetry(passed)).toEqual([]);
  });
  it(`stops retrying alone after ${ALONE_LIMIT} runs in a row`, () => {
    expect(noAloneRetry({ z: ALONE_LIMIT, a: ALONE_LIMIT + 2, b: ALONE_LIMIT - 1 })).toEqual(["a", "z"]);
    expect(noAloneRetry(undefined)).toEqual([]);
  });
  it("the regular report shows each alone pass with its streak and its failure beside others", () => {
    const dir = artifacts("regular", {
      "harness-1/result.json": {
        results: [{ ...ok("a"), alone: true, parallelFails: ["frames: 3 long frames\nstack"] }],
      },
      "harness-2/result.json": { results: [ok("b")] },
      "storybook/result.json": { failures: [] },
      "repeat/repeat.json": { results: [], base: "abcdef0" },
    });
    const r = regularReport({
      dir,
      jobs: { e2e: { result: "success" } },
      comments: [],
      run: "r",
      sha: "s",
      tiers: TIERS,
      streaks: { a: 2 },
    });
    expect(r.flaky.alone).toEqual(["a"]);
    expect(r.body).toContain(`- a (2 of ${ALONE_LIMIT} in a row): frames: 3 long frames`);
  });
});

describe("which changes run the perf job (tiers.json perf)", () => {
  it("source of the packages, the benchmark drivers and the lockfile; not docs, scenarios or the extension", () => {
    const run = [
      "packages/board/src/canvas/Links.tsx",
      "packages/host/src/views.ts",
      "packages/markdown/package.json",
      "packages/board/vite.config.ts",
      "packages/board/test/perf.ts",
      "packages/board/test/harness.ts",
      "packages/host/test/perf-host.ts",
      "package-lock.json",
      "tools/review/perf-ab.sh",
    ];
    const skip = [
      "README.md",
      "packages/board/test/scenarios/links.spec.ts",
      "packages/host/test/hub.test.ts",
      "extensions/vscode/src/panel.ts",
      "tools/test/harness.mjs",
    ];
    expect(perfFiles([...run, ...skip], TIERS)).toEqual(run);
  });
});
