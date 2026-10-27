// Picks the harness scenarios a change needs, within a time budget. Used by tools/test/harness.mjs --select (CI and npm run check).
//
// Always run, whatever the budget:
//   focus   scenarios being worked on: named with --focus or on a "Tests:" line of the PR description, defined in a test file the
//           change touches, new since the last nightly run, or failing in the last nightly run
//   smoke   the fixed list in packages/board/test/tiers.json: one quick scenario per main feature, so a big break never slips through
// Then, while the budget lasts:
//   affected  scenarios that ran a changed source file in the last nightly run (impact map), those that ran the fewest other
//             files first. A change the map can't place (CSS, build config, lockfile, the harness itself, a source file no scenario
//             ran) counts every scenario as affected, the quickest first. A new source file is placed through the changed files
//             that import it; only when nothing else changed it can't be placed.
// What doesn't fit is reported as deferred: the nightly run covers it.
//
// repeatPick (harness.mjs --changed-since, the nightly flake repeat): the scenarios defined in test files changed since a commit,
// the quickest first, within a wall-time cap for running each of them several times.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 }).trim();
export const DEFAULT_MS = 10000;
/** A scenario's expected time: its time in the last nightly run; one that run doesn't have (new since) takes the median there, as a
 *  new scenario is about as quick as the others (a flat guess of 10 s made a few new ones crowd affected ones out of the budget) */
export function msOf(impact) {
  const map = impact.map?.scenarios ?? {};
  const all = Object.values(map).map((s) => s.ms).sort((a, b) => a - b);
  const typical = all.length ? all[all.length >> 1] : DEFAULT_MS;
  return (n) => map[n]?.ms ?? typical;
}

/**
 * Nightly results stored on the ci-screenshots branch: impact/harness.json { commit, generated, scenarios: { name: { ms, files: [paths] } } }
 * and impact/failing.json [scenario names]. Cached for 6 hours in test-out/impact/. IMPACT_DIR=<dir> reads them from a local dir instead.
 */
export function loadImpact() {
  const dir = process.env.IMPACT_DIR || path.join(REPO, "test-out/impact");
  const f = path.join(dir, "harness.json");
  const fresh = fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3;
  if (!process.env.IMPACT_DIR && !fresh) {
    try {
      git("fetch", "-q", "--depth", "1", "origin", "ci-screenshots");
      fs.mkdirSync(dir, { recursive: true });
      for (const n of ["harness.json", "failing.json"]) fs.writeFileSync(path.join(dir, n), git("show", `FETCH_HEAD:impact/${n}`));
    } catch { /* no nightly results yet, or offline: what is cached */ }
  }
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { return d; } };
  return { map: read("harness.json", null), failing: read("failing.json", []) };
}

/**
 * Files changed between `base` (a commit) and the working tree, uncommitted and untracked files included: { files, added }.
 * Throws when base isn't a commit of this clone: picking against some other commit would pick the wrong scenarios.
 */
export function changes(base) {
  try { git("rev-parse", "--verify", "-q", `${base}^{commit}`); }
  catch { throw new Error(`base ${base} is not a commit in this clone: fetch it (CI: fetch-depth 0) or pass --base=<commit>`); }
  const files = new Set(), added = new Set();
  for (const l of git("diff", "--name-status", "--no-renames", base).split("\n").filter(Boolean)) {
    const [st, f] = l.split("\t");
    files.add(f);
    if (st === "A") added.add(f);
  }
  for (const f of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) { files.add(f); added.add(f); }
  return { files: [...files], added: [...added] };
}

/** Names on a "Tests: a, b" line (PR description) */
export const testsLine = (text) => [...(text ?? "").matchAll(/^\s*tests?\s*:\s*(.+)$/gim)].flatMap((m) => m[1].split(/[\s,`]+/)).filter(Boolean);

// Changes that can affect any scenario without showing up in the coverage of one
const GLOBAL = [
  /^package(-lock)?\.json$/, /^packages\/(board|core|host|markdown)\/(package\.json|tsconfig[^/]*\.json|vite\.config\.\w+|playwright\.config\.\w+)$/,
  /^packages\/(board|markdown)\/src\/.*\.css$/, /^packages\/board\/src\/fonts\//,
  /^packages\/board\/test\/(harness|fixtures|coverage|subhost|chromium)\.ts$/, /^packages\/board\/test\/tiers\.json$/,
  /^packages\/host\/test\/(node-workspace\.ts|fixtures\/)/, /^tools\/test\//,
];
const SRC = /^packages\/(board|core|host|markdown)\/src\//;

/**
 * all: { name: defining test file }, change: changes(), impact: loadImpact(), tiers: tiers.json, focus: [names], budgetMs: total scenario time
 * → { run: [{ name, why, ms }], deferred: [names], notes: [strings] }
 */
export function pick({ all, change, impact, tiers, focus = [], budgetMs }) {
  const names = Object.keys(all).filter((n) => !(tiers.manual ?? []).includes(n));
  const map = impact.map?.scenarios ?? {};
  const ms = msOf(impact);
  const notes = [];
  const why = new Map();
  const add = (n, w) => { if (all[n] && !why.has(n)) why.set(n, w); };
  for (const n of focus) { if (all[n]) add(n, "asked"); else notes.push(`unknown scenario: ${n}`); }
  for (const n of changedScenarios(all, change, tiers)) add(n, "test changed");
  if (impact.map) for (const n of names) if (!map[n]) add(n, "new");
  for (const n of impact.failing ?? []) add(n, "failing last night");
  for (const n of tiers.smoke ?? []) add(n, "smoke");

  const global = change.files.filter((f) => GLOBAL.some((re) => re.test(f)));
  const seen = new Set(Object.values(map).flatMap((s) => s.files ?? []));
  const src = change.files.filter((f) => SRC.test(f) && !global.includes(f));
  const placed = src.filter((f) => seen.has(f));
  const unplaced = src.filter((f) => !seen.has(f) && !(placed.length && change.added.includes(f)));
  const rest = names.filter((n) => !why.has(n));
  let affected = [];
  if (global.length || unplaced.length || (src.length && !impact.map)) {
    const causes = [...global, ...unplaced];
    notes.push(`every scenario may be affected (${causes.length ? causes.slice(0, 4).join(", ") + (causes.length > 4 ? ", …" : "") : "no impact map yet"}): quickest first`);
    affected = rest.sort((a, b) => ms(a) - ms(b) || a.localeCompare(b));
  } else if (placed.length) {
    const files = (n) => map[n]?.files ?? [];
    const hit = (n) => files(n).filter((f) => placed.includes(f)).length;
    affected = rest.filter((n) => hit(n) > 0).sort((a, b) => files(a).length - files(b).length || ms(a) - ms(b) || a.localeCompare(b));
  }
  let used = [...why.keys()].reduce((t, n) => t + ms(n), 0);
  if (used > budgetMs) notes.push(`focus and smoke alone take ${Math.round(used / 1000)} s, over the ${Math.round(budgetMs / 1000)} s budget`);
  const deferred = [];
  for (const n of affected) {
    if (used + ms(n) <= budgetMs) { why.set(n, "affected"); used += ms(n); } else deferred.push(n);
  }
  return { run: [...why].map(([name, w]) => ({ name, why: w, ms: ms(name) })), deferred, notes };
}

/** Scenarios (manual ones left out) defined in a test file the change touches; a new scenario is always in one */
export const changedScenarios = (all, change, tiers) =>
  Object.keys(all).filter((n) => !(tiers.manual ?? []).includes(n) && change.files.includes(all[n]));

/**
 * The flake repeat: changedScenarios, the quickest first, while the estimated wall time of `repeat` runs of each fits in capMs:
 * the "solo" ones (tiers.json) one at a time, the others on `workers` workers.
 * → { run: [{ name, why, ms }], deferred: [names], notes: [strings] }
 */
export function repeatPick({ all, change, impact, tiers, repeat, workers, capMs }) {
  const ms = msOf(impact);
  const cost = (n) => (ms(n) * repeat) / ((tiers.solo ?? []).includes(n) ? 1 : workers);
  const names = changedScenarios(all, change, tiers).sort((a, b) => ms(a) - ms(b) || a.localeCompare(b));
  const run = [], deferred = [];
  let used = 0;
  for (const n of names) {
    if (used + cost(n) <= capMs) { run.push({ name: n, why: "test changed", ms: ms(n) }); used += cost(n); } else deferred.push(n);
  }
  const notes = deferred.length ? [`${deferred.length} changed scenarios over the ${+(capMs / 60000).toFixed(1)} min cap, not repeated: ${deferred.join(", ")}`] : [];
  return { run, deferred, notes };
}

/** Longest-first split into n shards of about equal time; shard k (1-based) */
export function shard(items, k, n, ms) {
  const bins = Array.from({ length: n }, () => ({ t: 0, items: [] }));
  for (const it of [...items].sort((a, b) => ms(b) - ms(a) || a.name.localeCompare(b.name))) {
    const bin = bins.reduce((m, b) => (b.t < m.t ? b : m));
    bin.items.push(it); bin.t += ms(it);
  }
  return bins[k - 1].items;
}
