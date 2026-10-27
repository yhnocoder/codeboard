// Runs the board harness scenarios (Playwright Test: packages/board/playwright.config.ts) with packages/board/test/tiers.json applied.
// Usage: node tools/test/harness.mjs [scenario…] [--workers=N] [--shard=i/n] [--coverage] [--light] [--json=out.json]
//          no names: every scenario except the manual ones
//        --select [--base=<commit>] [--budget=<seconds>] [--focus=a,b]: only the scenarios the change since <commit> (default HEAD)
//          needs (tools/test/pick.mjs; a "Tests:" line in PR_BODY counts as --focus)
//        --coverage: also record which source files each scenario runs (nightly, for --select)
//        --against=<ref>: run the scenarios (as they are now) on the board built from <ref>: does a new scenario fail on the old code?
//          The build is made once per commit in a git worktree, test-out/against/<commit>
//        --changed-since=<commit> --repeat=N [--cap=<minutes>]: the nightly flake repeat. The scenarios defined in test files changed
//          since <commit> (tools/test/pick.mjs repeatPick), each run N times (Playwright --repeat-each), within a wall-time cap
//          (default 15 min). No second run alone: any failed repetition fails the scenario. A missing or unknown <commit> is an
//          error, written to --json as { error } (no fallback to some other set of scenarios).
// Two Playwright runs: the scenarios on N workers, then one at a time the "solo" ones (they measure timing) and those that failed
// beside others (a failure that passes alone counts as passed, reported as "alone"). Checks listed under "known" fail nothing
// (fixtures.ts) but are reported. Exits 1 on any failure.
// --json: { wall, workers, results: [{ name, why, ok, ms, fails, known, alone, files, runs, failed }], deferred, notes, base, repeat, error }
//   runs and failed (how many repetitions ran and failed) only with --repeat
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pick, repeatPick, shard, loadImpact, changes, testsLine, msOf as estimate } from "./pick.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PW = [path.join(REPO, "node_modules/.bin/playwright"), "test", "-c", path.join(REPO, "packages/board/playwright.config.ts")];
const OUT = path.join(REPO, "test-out/harness");
const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k) => args.includes(`--${k}`);
const names = args.filter((a) => !a.startsWith("--"));
const tiers = JSON.parse(fs.readFileSync(path.join(REPO, "packages/board/test/tiers.json"), "utf8"));
const env = { ...process.env, ...(has("coverage") ? { HARNESS_COV: "1" } : {}), ...(has("light") ? { HARNESS_LIGHT: "1" } : {}) };
const repeat = Math.max(1, +(opt("repeat") ?? 1));
const writeJson = (data) => {
  const out = opt("json");
  if (!out) return;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 1));
};
// with --changed-since the error goes into --json too, so that the nightly report shows it
const sinceMode = has("changed-since") || opt("changed-since") !== undefined;
const die = (msg) => { console.error(msg); if (sinceMode) writeJson({ error: msg, results: [] }); process.exit(2); };

// Every scenario: name → the test file that defines it
const listed = spawnSync(PW[0], [...PW.slice(1), "--list", "--reporter=json"], { cwd: REPO, env, encoding: "utf8", maxBuffer: 64 << 20 });
if (listed.status !== 0) die(`listing the scenarios failed:\n${listed.stderr}${listed.stdout.slice(0, 4000)}`);
const report = JSON.parse(listed.stdout);
const specs = (suites) => suites.flatMap((s) => [...(s.specs ?? []), ...specs(s.suites ?? [])]);
const all = {};
for (const s of specs(report.suites)) {
  if (all[s.title]) die(`two scenarios named ${s.title}: ${all[s.title]} and ${s.file}`);
  all[s.title] = path.relative(REPO, path.resolve(report.config.rootDir, s.file));
}
const impact = loadImpact();
const msOf = estimate(impact);

let list, plan;
const since = opt("changed-since");
const workersWanted = +(opt("workers") ?? Math.min(4, os.availableParallelism()));
if (sinceMode) {
  if (!since) die("--changed-since: no base commit (no previous scheduled nightly run found): nothing repeated");
  let change;
  try { change = changes(since); } catch (e) { die(`--changed-since: ${e.message}`); }
  plan = repeatPick({ all, change, impact, tiers, repeat, workers: workersWanted, capMs: +(opt("cap") ?? 15) * 60000 });
  list = plan.run;
  console.log(`test files changed since ${since.slice(0, 7)}: ${change.files.filter((f) => Object.values(all).includes(f)).length}`);
  for (const n of plan.notes) console.log(`note: ${n}`);
} else if (names.length) {
  const bad = names.filter((n) => !all[n]);
  if (bad.length) die(`unknown scenario: ${bad.join(", ")}`);
  list = names.map((name) => ({ name, why: "asked" }));
} else if (has("select")) {
  const focus = [...(opt("focus") ?? "").split(","), ...testsLine(process.env.PR_BODY)].filter(Boolean);
  let change;
  try { change = changes(opt("base") || "HEAD"); } catch (e) { die(e.message); }
  plan = pick({ all, change, impact, tiers, focus, budgetMs: +(opt("budget") ?? 400) * 1000 });
  list = plan.run;
  console.log(`changed files: ${change.files.length}${impact.map ? `, impact map from ${impact.map.commit?.slice(0, 7)} (${impact.map.generated})` : ", no impact map yet"}`);
  for (const n of plan.notes) console.log(`note: ${n}`);
} else list = Object.keys(all).filter((n) => !(tiers.manual ?? []).includes(n)).map((name) => ({ name, why: "all" }));
const sh = opt("shard")?.split("/").map(Number);
if (sh) list = shard(list, sh[0], sh[1], (it) => msOf(it.name));

const against = opt("against");
if (against) {
  const git = (...a) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" });
  const sha = git("rev-parse", "--verify", "-q", `${against}^{commit}`).stdout.trim();
  if (!sha) die(`--against: ${against} is not a commit in this clone`);
  const dir = path.join(REPO, "test-out/against", sha), media = path.join(dir, "extensions/vscode/media/board");
  if (!fs.existsSync(path.join(media, "board.js"))) {
    console.log(`building the board at ${sha.slice(0, 7)} in ${path.relative(REPO, dir)}`);
    git("worktree", "remove", "--force", dir); fs.rmSync(dir, { recursive: true, force: true }); git("worktree", "prune");
    const add = git("worktree", "add", "--detach", dir, sha);
    if (add.status) die(`--against: git worktree add failed:\n${add.stderr}`);
    for (const cmd of ["npm ci --prefer-offline --no-audit --no-fund", "npm run build -w @yhnocoder/markdown", "npm run build -w @codeboard/board"]) {
      const r = spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.status) die(`--against: ${cmd} failed at ${sha.slice(0, 7)}:\n${(r.stdout + r.stderr).slice(-3000)}`);
    }
  }
  env.HARNESS_BOARD = media;
  console.log(`on the board of ${against} (${sha.slice(0, 7)}), not the current build`);
}

const workers = Math.max(1, Math.min(workersWanted, list.length * repeat));
const why = Object.fromEntries(list.map((x) => [x.name, x.why]));
const counts = Object.entries(Object.groupBy(list, (x) => x.why)).map(([w, xs]) => `${xs.length} ${w}`).join(", ");
console.log(`running ${list.length} scenarios${repeat > 1 ? ` ${repeat} times each` : ""} (${counts || "none"}) on ${workers} worker${workers > 1 ? "s" : ""}${plan?.deferred.length ? `; ${plan.deferred.length} ${since ? "not repeated (over the cap)" : "deferred to the nightly run"}` : ""}`);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** One Playwright run of these scenarios (each `repeat` times) → their results */
async function run(scenarios, n, tag) {
  if (!scenarios.length) return [];
  const json = path.join(OUT, `run-${tag}.json`);
  fs.rmSync(json, { force: true });
  // a test's grep title is " <file> <title>": match the title exactly
  const grep = `\\.spec\\.mjs (${scenarios.map(esc).join("|")})\\s*$`;
  await new Promise((resolve) => {
    const p = spawn(PW[0], [...PW.slice(1), "-g", grep, `--workers=${n}`, ...(repeat > 1 ? [`--repeat-each=${repeat}`] : []), "--reporter=list,json"], { cwd: REPO, stdio: "inherit", env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: json } });
    p.on("close", resolve);
  });
  const got = fs.existsSync(json) ? specs(JSON.parse(fs.readFileSync(json, "utf8")).suites) : [];
  return scenarios.map((name) => {
    // one test per repetition (--repeat-each), each with its last result
    const runs = got.filter((s) => s.title === name).flatMap((s) => s.tests).map((t) => ({ t, r: t.results.at(-1) })).filter((x) => x.r);
    if (!runs.length) return { name, ok: false, ms: 0, fails: ["did not run (see the log)"], known: [], ...(repeat > 1 ? { runs: 0, failed: repeat } : {}) };
    const bad = runs.filter((x) => x.r.status !== "passed");
    const missing = Math.max(0, repeat - runs.length);
    const { r } = bad[0] ?? runs.at(-1);
    const cov = r.attachments?.find((a) => a.name === "coverage" && a.body);
    // each failed check or error: its message, without expect's explanation and code frame
    const msgs = (x) => (x.errors ?? []).map((e) => strip(e.message ?? e.value ?? "").trim().split("\n\n")[0].replace(/^Error: /, "").slice(0, 400));
    const uniq = (xs) => xs.filter((d, i, a) => a.indexOf(d) === i);
    return {
      name, ok: !bad.length && !missing, ms: Math.round(runs.reduce((t, x) => t + x.r.duration, 0) / runs.length),
      fails: uniq([...bad.flatMap((x) => msgs(x.r)), ...(missing ? [`${missing} of ${repeat} repetitions did not run (see the log)`] : [])]),
      known: uniq(runs.flatMap(({ t, r }) => [...(t.annotations ?? []), ...(r.annotations ?? [])]).filter((a) => a.type === "known").map((a) => a.description)),
      ...(cov ? { files: JSON.parse(Buffer.from(cov.body, "base64").toString("utf8")) } : {}),
      ...(repeat > 1 ? { runs: runs.length, failed: bad.length + missing } : {}),
    };
  });
}

const t0 = Date.now();
// "solo" scenarios (tiers.json) measure timing (frames, render lag) and run alone after the others, like the perf benchmark
const solo = list.map((x) => x.name).filter((n) => (tiers.solo ?? []).includes(n));
const results = await run(list.map((x) => x.name).filter((n) => !solo.includes(n)), workers, "parallel");
// A scenario that failed while others ran beside it gets one more run alone: some measure timing (reveal lag, frame times)
// and lose to the CPU load of the other scenarios. Passing alone counts as passing, and the report says so.
// Not in the flake repeat: there a failure beside others is what it looks for.
const retry = workers > 1 && repeat === 1 ? results.filter((r) => !r.ok).map((r) => r.name) : [];
if (solo.length || retry.length) {
  console.log(`\nalone: ${[...solo.map((n) => `${n} (solo)`), ...retry].join(", ")}`);
  const again = await run([...solo, ...retry], 1, "alone");
  for (const r of again) {
    const i = results.findIndex((x) => x.name === r.name);
    if (i < 0) results.push(r); else results[i] = { ...r, ...(r.ok ? { alone: true } : {}) };
  }
}

const failed = results.filter((r) => !r.ok);
const knownHit = [...new Set(results.flatMap((r) => r.known))];
const alone = results.filter((r) => r.alone).map((r) => r.name);
const wall = Math.round((Date.now() - t0) / 1000);
console.log(`\n${failed.length ? `${failed.length} of ${results.length} scenarios failed: ${failed.map((r) => r.name).join(", ")}` : `all ${results.length} scenarios passed`} in ${wall} s` +
  (knownHit.length ? `; ${knownHit.length} known failures (tiers.json)` : "") + (alone.length ? `; passed only when run alone: ${alone.join(", ")}` : ""));
for (const r of failed) for (const f of r.fails.slice(0, 3)) console.log(`  ${r.name}: ${f.split("\n")[0]}`);
if (plan?.deferred.length) console.log(`${since ? "not repeated (over the cap)" : "deferred to the nightly run"}: ${plan.deferred.join(", ")}`);
writeJson({ wall, workers, results: results.map((r) => ({ ...r, why: why[r.name] })), deferred: plan?.deferred ?? [], notes: plan?.notes ?? [],
  ...(since ? { base: since, repeat } : {}) });
process.exit(failed.length ? 1 : 0);
