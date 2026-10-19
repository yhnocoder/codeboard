// Runs the board harness scenarios (Playwright Test: packages/board/playwright.config.ts) with packages/board/test/tiers.json applied.
// Usage: node tools/test/harness.mjs [scenario…] [--workers=N] [--shard=i/n] [--coverage] [--light] [--json=out.json]
//          no names: every scenario except the manual ones
//        --select [--base=<commit>] [--budget=<seconds>] [--focus=a,b]: only the scenarios the change since <commit> (default HEAD)
//          needs (tools/test/pick.mjs; a "Tests:" line in PR_BODY counts as --focus)
//        --coverage: also record which source files each scenario runs (nightly, for --select)
// Two Playwright runs: the scenarios on N workers, then one at a time the "solo" ones (they measure timing) and those that failed
// beside others (a failure that passes alone counts as passed, reported as "alone"). Checks listed under "known" fail nothing
// (fixtures.ts) but are reported. Exits 1 on any failure.
// --json: { wall, workers, results: [{ name, why, ok, ms, fails, known, alone, files }], deferred, notes }
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pick, shard, loadImpact, changes, testsLine, DEFAULT_MS } from "./pick.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PW = [path.join(REPO, "node_modules/.bin/playwright"), "test", "-c", path.join(REPO, "packages/board/playwright.config.ts")];
const OUT = path.join(REPO, "test-out/harness");
const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k) => args.includes(`--${k}`);
const names = args.filter((a) => !a.startsWith("--"));
const tiers = JSON.parse(fs.readFileSync(path.join(REPO, "packages/board/test/tiers.json"), "utf8"));
const env = { ...process.env, ...(has("coverage") ? { HARNESS_COV: "1" } : {}), ...(has("light") ? { HARNESS_LIGHT: "1" } : {}) };
const die = (msg) => { console.error(msg); process.exit(2); };

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
const msOf = (n) => impact.map?.scenarios?.[n]?.ms ?? DEFAULT_MS;

let list, plan;
if (names.length) {
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

const workers = Math.max(1, Math.min(+(opt("workers") ?? Math.min(4, os.availableParallelism())), list.length));
const why = Object.fromEntries(list.map((x) => [x.name, x.why]));
const counts = Object.entries(Object.groupBy(list, (x) => x.why)).map(([w, xs]) => `${xs.length} ${w}`).join(", ");
console.log(`running ${list.length} scenarios (${counts || "none"}) on ${workers} worker${workers > 1 ? "s" : ""}${plan?.deferred.length ? `; ${plan.deferred.length} deferred to the nightly run` : ""}`);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** One Playwright run of these scenarios → their results */
async function run(scenarios, n, tag) {
  if (!scenarios.length) return [];
  const json = path.join(OUT, `run-${tag}.json`);
  fs.rmSync(json, { force: true });
  // a test's grep title is " <file> <title>": match the title exactly
  const grep = `\\.spec\\.mjs (${scenarios.map(esc).join("|")})\\s*$`;
  await new Promise((resolve) => {
    const p = spawn(PW[0], [...PW.slice(1), "-g", grep, `--workers=${n}`, "--reporter=list,json"], { cwd: REPO, stdio: "inherit", env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: json } });
    p.on("close", resolve);
  });
  const got = fs.existsSync(json) ? specs(JSON.parse(fs.readFileSync(json, "utf8")).suites) : [];
  return scenarios.map((name) => {
    const t = got.find((s) => s.title === name)?.tests[0], r = t?.results.at(-1);
    if (!r) return { name, ok: false, ms: 0, fails: ["did not run (see the log)"], known: [] };
    const cov = r.attachments?.find((a) => a.name === "coverage" && a.body);
    return {
      name, ok: r.status === "passed", ms: r.duration,
      // each failed check or error: its message, without expect's explanation and code frame
      fails: (r.errors ?? []).map((e) => strip(e.message ?? e.value ?? "").trim().split("\n\n")[0].replace(/^Error: /, "").slice(0, 400)),
      known: [...(t.annotations ?? []), ...(r.annotations ?? [])].filter((a) => a.type === "known").map((a) => a.description).filter((d, i, a) => a.indexOf(d) === i),
      ...(cov ? { files: JSON.parse(Buffer.from(cov.body, "base64").toString("utf8")) } : {}),
    };
  });
}

const t0 = Date.now();
// "solo" scenarios (tiers.json) measure timing (frames, render lag) and run alone after the others, like the perf benchmark
const solo = list.map((x) => x.name).filter((n) => (tiers.solo ?? []).includes(n));
const results = await run(list.map((x) => x.name).filter((n) => !solo.includes(n)), workers, "parallel");
// A scenario that failed while others ran beside it gets one more run alone: some measure timing (reveal lag, frame times)
// and lose to the CPU load of the other scenarios. Passing alone counts as passing, and the report says so.
const retry = workers > 1 ? results.filter((r) => !r.ok).map((r) => r.name) : [];
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
if (plan?.deferred.length) console.log(`deferred to the nightly run: ${plan.deferred.join(", ")}`);
const out = opt("json");
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ wall, workers, results: results.map((r) => ({ ...r, why: why[r.name] })), deferred: plan?.deferred ?? [], notes: plan?.notes ?? [] }, null, 1));
}
process.exit(failed.length ? 1 : 0);
