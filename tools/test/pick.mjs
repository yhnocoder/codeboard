// Picks the harness scenarios a change needs. Used by tools/test/harness.mjs --select (npm run check; CI with --ci).
//
// npm run check runs a fixed set, chosen by what the change touches and never cut by time:
//   asked     named with --focus or on a "Tests:" line of the PR description
//   added     scenarios this change adds: in neither the base version of their file nor the last regular run (a scenario moved to
//             another file, or a renamed file, adds nothing)
//   failing   failing in the last regular run
//   smoke     the fixed list in packages/board/test/tiers.json: one quick scenario per main feature, so a big break never slips through
//   areas     the whole group of every feature area (tiers.json "areas", tools/test/areas.mjs) that a changed source file or scenario
//             spec belongs to. The groups are picked by hand to cover their area's main behaviour: a change runs what matters for
//             what it touches. Ordering by time and cutting at a budget would run whatever is quick instead
//   broad     a change no area can hold (the shared stylesheet and fonts, build and test config, the lockfile, the harness, the
//             example repository, or a source file or spec left out of every area): the "broad" group. Docs, unit tests, the
//             extension and tiers.json itself run no scenario code: smoke only
// Scenarios the change edits outside these sets are listed as run in CI. A set over the time budget still runs whole, with a
// warning that names the groups behind it: a group that grew too big gets trimmed, the run doesn't silently drop it.
//
// CI (ci) adds every scenario the change edits (scenarioChanges), then sizes the harness jobs: enough shards of ci.perShardMs of
// scenario time for that set (ci.minShards to ci.maxShards), the rest of their room filled with:
//   new       scenarios the last regular run doesn't have yet that this change doesn't touch (another branch added them; their own
//             PR ran them), the quickest first
//   affected  scenarios that ran a changed source file in the last regular run (impact map), those that ran the fewest other
//             files first. A change the map can't place (broad, a source file no scenario ran) counts every scenario as affected,
//             the quickest first. A new source file is placed through the changed files that import it; only when nothing else
//             changed it can't be placed.
// The fill is extra coverage: what doesn't fit is left to the regular run (every scenario). The required set is never cut; when
// it needs more than ci.maxShards it all runs on longer jobs, and the notes say so.
//
// repeatPick (harness.mjs --changed-since, the regular runs' flake repeat): the scenarios added, then those changed, since a commit, the
// quickest first within each, within a wall-time cap for running each of them several times.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { areasOf, groupTimes } from "./areas.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 }).trim();
export const DEFAULT_MS = 10000;
/** A scenario's expected time: its time in the last regular run; one that run doesn't have (new since) takes the median there, as a
 *  new scenario is about as quick as the others (a flat guess of 10 s made a few new ones crowd affected ones out of the budget) */
export function msOf(impact) {
  const map = impact.map?.scenarios ?? {};
  const all = Object.values(map).map((s) => s.ms).sort((a, b) => a - b);
  const typical = all.length ? all[all.length >> 1] : DEFAULT_MS;
  return (n) => map[n]?.ms ?? typical;
}

/**
 * Regular-run results stored on the ci-screenshots branch: impact/harness.json { commit, generated, scenarios: { name: { ms, files: [paths] } } }
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
    } catch { /* no regular-run results yet, or offline: what is cached */ }
  }
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { return d; } };
  return { map: read("harness.json", null), failing: read("failing.json", []) };
}

/**
 * Files changed between `base` (a commit) and the working tree, uncommitted and untracked files included: { base, files, added }.
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
  return { base, files: [...files], added: [...added] };
}

/** Names on a "Tests: a, b" line (PR description) */
export const testsLine = (text) => [...(text ?? "").matchAll(/^\s*tests?\s*:\s*(.+)$/gim)].flatMap((m) => m[1].split(/[\s,`]+/)).filter(Boolean);

const SRC = /^packages\/(board|core|host|markdown|analysis)\/src\//;
const secs = (ms) => Math.round(ms / 1000);
const list = (xs, n = 4) => xs.slice(0, n).join(", ") + (xs.length > n ? ", …" : "");

/**
 * all: { name: defining test file }, change: changes(), impact: loadImpact(), tiers: tiers.json, focus: [names], budgetMs: npm run
 * check's share of scenario time, for the warning only, changed: scenarioChanges(),
 * ci: { perShardMs, minShards, maxShards } in CI
 * → { run: [{ name, why, ms }], areas: [{ name, files, ms }] (each group run: the files that touched it, the time it adds),
 *   forCI: [edited scenarios not run here], deferred: [names] (CI: the fill that didn't fit), shards (CI), notes: [strings] }
 */
export function pick({ all, change, impact, tiers, focus = [], budgetMs, ci, changed = scenarioChanges(all, change, tiers, impact) }) {
  const names = Object.keys(all).filter((n) => !(tiers.manual ?? []).includes(n));
  const map = impact.map?.scenarios ?? {};
  const ms = msOf(impact);
  const quick = (a, b) => ms(a) - ms(b) || a.localeCompare(b);
  const notes = [];
  const why = new Map();
  const add = (n, w) => { if (all[n] && !why.has(n)) why.set(n, w); };
  for (const n of focus) { if (all[n]) add(n, "asked"); else notes.push(`unknown scenario: ${n}`); }
  for (const n of changed.added) add(n, "test added");
  for (const n of impact.failing ?? []) add(n, "failing in the last regular run");
  for (const n of tiers.smoke ?? []) add(n, "smoke");
  const fixed = [...why.keys()].reduce((t, n) => t + ms(n), 0);

  const touched = areasOf(change.files, tiers);
  if (touched.unplaced.length) notes.push(`in no area of tiers.json, run as broad: ${list(touched.unplaced)}`);
  const broad = [...touched.broad, ...touched.unplaced];
  const groups = [];
  const runGroup = (name, group, files) => {
    let t = 0;
    for (const n of group?.scenarios ?? []) {
      if (!all[n]) { notes.push(`tiers.json ${name}: no scenario named ${n}`); continue; }
      if (!why.has(n)) { why.set(n, name === "broad" ? "broad" : `area ${name}`); t += ms(n); }
    }
    groups.push({ name, files, ms: t });
  };
  if (broad.length) runGroup("broad", tiers.broad, broad);
  for (const [a, files] of Object.entries(touched.areas)) runGroup(a, tiers.areas?.[a], files);
  for (const g of groupTimes(tiers, ms).groups) {
    if (g.over && groups.some((x) => x.name === g.name)) notes.push(`group ${g.name} takes ${secs(g.ms)} s beside smoke, over its ${tiers.limits.area} s limit (tiers.json): trim it`);
  }
  const edited = changed.edited.filter((n) => all[n] && !why.has(n)).sort(quick);
  const run = () => [...why].map(([name, w]) => ({ name, why: w, ms: ms(name) }));

  if (!ci) {
    const used = fixed + groups.reduce((t, g) => t + g.ms, 0);
    if (budgetMs !== undefined && used > budgetMs) {
      const big = [...groups].sort((a, b) => b.ms - a.ms).map((g) => `${g.name} +${secs(g.ms)} s`);
      notes.push(`over the budget, not cut: ${secs(used)} s of scenario time against ${secs(budgetMs)} s (asked, added, failing and smoke ${secs(fixed)} s` +
        `${big.length ? `; groups ${big.join(", ")}` : ""}). Trim the groups in tiers.json, or split a change that touches this many areas`);
    }
    return { run: run(), areas: groups, forCI: edited, deferred: [], notes };
  }

  for (const n of edited) why.set(n, "test changed");
  const must = [...why.keys()].reduce((t, n) => t + ms(n), 0);
  const shards = Math.min(ci.maxShards, Math.max(ci.minShards ?? 1, Math.ceil(must / ci.perShardMs)));
  const room = shards * ci.perShardMs;
  if (must > room) notes.push(`the scenarios this change needs take ${secs(must)} s of scenario time, more than ${shards} harness jobs of ${secs(ci.perShardMs)} s hold: all of them run, the jobs take longer`);
  const seen = new Set(Object.values(map).flatMap((s) => s.files ?? []));
  const src = change.files.filter((f) => SRC.test(f) && !broad.includes(f));
  const placed = src.filter((f) => seen.has(f));
  const unseen = src.filter((f) => !seen.has(f) && !(placed.length && change.added.includes(f)));
  const fresh = impact.map ? names.filter((n) => !why.has(n) && !map[n]).sort(quick) : [];
  const rest = names.filter((n) => !why.has(n) && !fresh.includes(n));
  let affected = [];
  if (broad.length || unseen.length || (src.length && !impact.map)) {
    const causes = [...broad, ...unseen];
    notes.push(`every scenario may be affected (${causes.length ? list(causes) : "no impact map yet"}): the quickest first`);
    affected = rest.sort(quick);
  } else if (placed.length) {
    const files = (n) => map[n]?.files ?? [];
    affected = rest.filter((n) => files(n).some((f) => placed.includes(f))).sort((a, b) => files(a).length - files(b).length || quick(a, b));
  }
  let used = must;
  const deferred = [];
  for (const [n, w] of [...fresh.map((n) => [n, "new"]), ...affected.map((n) => [n, "affected"])]) {
    if (used + ms(n) <= room) { why.set(n, w); used += ms(n); } else deferred.push(n);
  }
  return { run: run(), areas: groups, forCI: [], deferred, shards, notes };
}

/** Scenarios (manual ones left out) whose code the change touches: the scenario's own test(…) block, or the part of its file before
 *  the first test (imports, shared helpers). Comments, whitespace and types don't count, so a comment-only cleanup of many test files
 *  doesn't rerun all their scenarios. → { added, edited } (names). Added: in neither the base version of its file nor the last
 *  regular run, so that moving a scenario to another file, or renaming its file, only edits it */
export function scenarioChanges(all, change, tiers, impact = {}) {
  const cache = new Map();
  const parts = (file) => {
    if (!cache.has(file)) {
      let before = "";
      try { before = git("show", `${change.base}:${file}`); } catch { /* new file */ }
      let now = "";
      try { now = fs.readFileSync(path.join(REPO, file), "utf8"); } catch { /* deleted */ }
      cache.set(file, [chunks(before), chunks(now)]);
    }
    return cache.get(file);
  };
  const ran = impact.map?.scenarios ?? {};
  const added = [], edited = [];
  for (const n of Object.keys(all)) {
    if ((tiers.manual ?? []).includes(n) || !change.files.includes(all[n])) continue;
    const [a, b] = parts(all[n]);
    if (!a.tests.has(n) && !ran[n]) added.push(n);
    else if (a.head !== b.head || !a.tests.has(n) || a.tests.get(n) !== b.tests.get(n)) edited.push(n);
  }
  return { added, edited };
}
/** A scenario file as { head, tests: name → code }: each top-level `test("name", …)` (one line, or up to its closing `});` line), and
 *  the rest of the file (imports, helpers, wherever they stand). Each part has comments, whitespace and types stripped (esbuild; imports kept, though the tests that use them are elsewhere); a part esbuild can't
 *  read on its own is kept as written, so any edit to it counts */
export function chunks(src) {
  const norm = (code) => { try { return esbuild.transformSync(code, { loader: "ts", minifyWhitespace: true, legalComments: "none", tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } }).code; } catch { return code; } };
  const tests = new Map();
  let head = "", from = 0;
  for (const m of src.matchAll(/^test\("([^"]+)"(?:[^\n]*\);[ \t]*$|[^]*?^\}\);?[ \t]*$)/gm)) {
    head += src.slice(from, m.index) + "\n";
    tests.set(m[1], norm(m[0]));
    from = m.index + m[0].length;
  }
  return { head: norm(head + src.slice(from)), tests };
}

/**
 * The flake repeat: the scenarios added since the commit, then those changed (scenarioChanges), the quickest first within each, while
 * the estimated wall time of `repeat` runs of each fits in capMs: the "solo" ones (tiers.json) one at a time, the others on `workers`
 * workers. Added ones first: one that has never run beside the others in a regular run is the likeliest to be flaky.
 * → { run: [{ name, why, ms }], deferred: [names], notes: [strings] }
 */
export function repeatPick({ all, change, impact, tiers, repeat, workers, capMs, changed = scenarioChanges(all, change, tiers, impact) }) {
  const ms = msOf(impact);
  const cost = (n) => (ms(n) * repeat) / ((tiers.solo ?? []).includes(n) ? 1 : workers);
  const quick = (a, b) => ms(a) - ms(b) || a.localeCompare(b);
  const names = [...[...changed.added].sort(quick).map((n) => [n, "test added"]), ...[...changed.edited].sort(quick).map((n) => [n, "test changed"])];
  const run = [], deferred = [];
  let used = 0;
  for (const [n, w] of names) {
    if (used + cost(n) <= capMs) { run.push({ name: n, why: w, ms: ms(n) }); used += cost(n); } else deferred.push(n);
  }
  const notes = deferred.length ? [`${deferred.length} added or changed scenarios over the ${+(capMs / 60000).toFixed(1)} min cap, not repeated: ${deferred.join(", ")}`] : [];
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
