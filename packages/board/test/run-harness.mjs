// Runs board harness scenarios (scenarios.ts, bundled with core and analysis to run under Node), several at a time.
// Usage: node run-harness.mjs [scenario…] [--light] [--workers=N] [--shard=i/n] [--json=out.json]
//          no names: every scenario except the manual ones in tiers.json
//        --select [--base=<commit>] [--budget=<seconds>] [--focus=a,b]: only the scenarios the change since <commit> needs (tools/test/pick.mjs)
//        --coverage: also record which source files each scenario runs (nightly, for --select)
// A scenario fails when it prints a line starting with FAIL, throws, or exits non-zero. Checks listed under "known" in
// tiers.json are reported but don't fail the run. Exits 1 on any other failure.
import { build } from "esbuild";
import { execFileSync, fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pick, shard, loadImpact, changes, testsLine, DEFAULT_MS } from "../../../tools/test/pick.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(here, "../../..");
const out = path.join(REPO, "test-out/harness/run.cjs");
const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k) => args.includes(`--${k}`);
const names = args.filter((a) => !a.startsWith("--"));
const pass = args.filter((a) => a === "--light");
const coverage = has("coverage");
const tiers = JSON.parse(fs.readFileSync(path.join(here, "tiers.json"), "utf8"));

await build({ entryPoints: [path.join(here, "scenarios.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, external: ["playwright-core", "@vscode/tree-sitter-wasm"], logLevel: "error", sourcemap: coverage });
const all = JSON.parse(execFileSync("node", [out, "--list-json"], { encoding: "utf8" }));
const impact = loadImpact();
const msOf = (n) => impact.map?.scenarios?.[n]?.ms ?? DEFAULT_MS;

let list, plan;
if (names.length) {
  const bad = names.filter((n) => !all[n]);
  if (bad.length) { console.error(`unknown scenario: ${bad.join(", ")}`); process.exit(2); }
  list = names.map((name) => ({ name, why: "asked" }));
} else if (has("select")) {
  const focus = [...(opt("focus") ?? "").split(","), ...testsLine(process.env.PR_BODY)].filter(Boolean);
  const base = opt("base") || "HEAD";
  const change = changes(base);
  let drifted = [];
  try { if (impact.map?.commit) drifted = execFileSync("git", ["diff", "--name-only", impact.map.commit, base], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); } catch { /* map commit not fetched */ }
  plan = pick({ all, change, impact, tiers, focus, budgetMs: +(opt("budget") ?? 400) * 1000, drifted });
  list = plan.run;
  console.log(`changed files: ${change.files.length}${impact.map ? `, impact map from ${impact.map.commit?.slice(0, 7)} (${impact.map.generated})` : ", no impact map yet"}`);
  for (const n of plan.notes) console.log(`note: ${n}`);
} else list = Object.keys(all).filter((n) => !(tiers.manual ?? []).includes(n)).map((name) => ({ name, why: "all" }));
const sh = opt("shard")?.split("/").map(Number);
if (sh) list = shard(list, sh[0], sh[1], (it) => msOf(it.name));

let workersNow;
const workers = Math.max(1, Math.min(+(opt("workers") ?? Math.min(4, os.availableParallelism())), list.length));
const why = Object.fromEntries(list.map((x) => [x.name, x.why]));
const counts = Object.entries(Object.groupBy(list, (x) => x.why)).map(([w, xs]) => `${xs.length} ${w}`).join(", ");
workersNow = workers;
console.log(`running ${list.length} scenarios (${counts || "none"}) on ${workers} worker${workers > 1 ? "s" : ""}${plan?.deferred.length ? `; ${plan.deferred.length} deferred to the nightly run` : ""}`);

// Longest first, so the slow ones don't end up alone at the end
// "solo" scenarios (tiers.json) measure timing (frames, render lag) and run alone after the others, like the perf benchmark
const solo = list.map((x) => x.name).filter((n) => (tiers.solo ?? []).includes(n));
const queue = list.map((x) => x.name).filter((n) => !solo.includes(n)).sort((a, b) => msOf(b) - msOf(a));
const results = [];
const TIMEOUT = 6 * 60e3;
const known = (line) => Object.keys(tiers.known ?? {}).find((k) => new RegExp(`^FAIL\\s+${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line));
const t0 = Date.now();

function report(r) {
  const unknown = r.fails.filter((f) => !known(f));
  r.ok = !r.error && !unknown.length;
  r.known = r.fails.filter(known);
  results.push(r);
  const mark = r.ok ? (r.known.length ? "⚠" : "✓") : "✗";
  if (workersNow > 1 && (!r.ok || process.env.HARNESS_VERBOSE)) process.stdout.write(r.log);
  console.log(`${mark} ${r.name} ${(r.ms / 1000).toFixed(1)}s${r.known.length ? ` (known: ${r.known.join("; ")})` : ""}${workersNow === 1 && workers > 1 && r.ok ? " (alone)" : ""}`);
  for (const f of unknown) console.log(`    ${f}`);
  if (r.error) console.log(r.error.replace(/^/gm, "    "));
}

async function runWorker() {
  while (queue.length) {
    const child = fork(out, pass, { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, ...(coverage ? { HARNESS_COV: "1" } : {}) } });
    let cur, log = "", timer;
    const next = () => {
      cur = queue.shift();
      if (!cur) return child.send({ type: "exit" });
      log = ""; clearTimeout(timer);
      timer = setTimeout(() => { log += `FAIL ${cur} timed out after ${TIMEOUT / 60e3} min\n`; child.kill("SIGKILL"); }, TIMEOUT);
      if (workersNow === 1) console.log("▶", cur);
      child.send({ type: "run", name: cur });
    };
    await new Promise((resolve) => {
      child.on("message", (m) => {
        if (m.type === "ready") next();
        else if (m.type === "log") { if (workersNow === 1) console.log(m.text); else log += m.text + "\n"; }
        else if (m.type === "done") { report({ ...m, log }); next(); }
      });
      // A scenario that calls process.exit, or a crash: count it as failed and go on in a new process
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (cur && !results.some((r) => r.name === cur)) {
          const fails = log.split("\n").filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
          report({ name: cur, ms: 0, fails, error: fails.length ? "" : `scenario process exited with code ${code}`, log });
        }
        resolve();
      });
    });
  }
}
await Promise.all(Array.from({ length: workers }, runWorker));
if (solo.length) {
  if (workers > 1) console.log(`\nalone (tiers.json solo): ${solo.join(", ")}`);
  queue.push(...solo);
  workersNow = 1;
  await runWorker();
}

// A scenario that failed while others ran beside it gets one more run alone: some measure timing (reveal lag, frame times)
// and lose to the CPU load of the other scenarios. Passing alone counts as passing, and the report says so.
const retry = workers > 1 ? results.filter((r) => !r.ok && !solo.includes(r.name)) : [];
if (retry.length) {
  console.log(`\nre-running alone: ${retry.map((r) => r.name).join(", ")}`);
  for (const r of retry) { results.splice(results.indexOf(r), 1); queue.push(r.name); }
  const n = results.length;
  workersNow = 1;
  await runWorker();
  for (const r of results.slice(n)) if (r.ok) r.alone = true;
}

const failed = results.filter((r) => !r.ok);
const knownHit = [...new Set(results.flatMap((r) => r.known))];
const alone = results.filter((r) => r.alone).map((r) => r.name);
const wall = Math.round((Date.now() - t0) / 1000);
console.log(`\n${failed.length ? `${failed.length} of ${results.length} scenarios failed: ${failed.map((r) => r.name).join(", ")}` : `all ${results.length} scenarios passed`} in ${wall} s` +
  (knownHit.length ? `; ${knownHit.length} known failures (tiers.json)` : "") + (alone.length ? `; passed only when run alone: ${alone.join(", ")}` : ""));
if (plan?.deferred.length) console.log(`deferred to the nightly run: ${plan.deferred.join(", ")}`);
const json = opt("json");
if (json) {
  fs.mkdirSync(path.dirname(path.resolve(json)), { recursive: true });
  fs.writeFileSync(json, JSON.stringify({ wall, workers, results: results.map(({ log, ...r }) => ({ ...r, why: why[r.name] })), deferred: plan?.deferred ?? [], notes: plan?.notes ?? [] }, null, 1));
}
process.exit(failed.length ? 1 : 0);
