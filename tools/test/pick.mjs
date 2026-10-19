// Picks the harness scenarios a change needs, within a time budget. Used by run-harness.mjs --select (CI and npm run check).
//
// Always run, whatever the budget:
//   focus   scenarios being worked on: named with --focus or on a "Tests:" line of the PR description, defined in a test file the
//           change touches, new since the last nightly run, or failing in the last nightly run
//   smoke   the fixed list in packages/board/test/tiers.json: one quick scenario per main feature, so a big break never slips through
// Then, while the budget lasts:
//   affected  scenarios that ran a changed source line in the last nightly run (impact map), the most specific to the change first.
//             Lines are matched in the base commit's numbering; for a file that also changed between the map's commit and the base,
//             any scenario that ran the file counts.
//             A change the map can't place (CSS, build config, lockfile, the harness itself, a file the map has never seen)
//             counts every scenario as affected, the quickest first.
// What doesn't fit is reported as deferred: the nightly run covers it.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 }).trim();
export const DEFAULT_MS = 10000;

/**
 * Nightly results stored on the ci-screenshots branch: impact/harness.json { commit, scenarios: { name: { ms, lines: { file: "3-7,9" } } },
 * files: [all seen] }
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
    } catch { /* no nightly results yet, or offline: fall back to what is cached */ }
  }
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { return d; } };
  return { map: read("harness.json", null), failing: read("failing.json", []) };
}

/**
 * What changed between `base` (a commit; default HEAD) and the working tree, uncommitted and untracked files included:
 * { files: [paths], hunks: { path: [[from, to]] } } with line ranges in base's numbering (an insertion covers the lines around it);
 * a new file has no hunks
 */
export function changes(base = "HEAD") {
  let diff;
  try { git("rev-parse", "--verify", "-q", `${base}^{commit}`); diff = git("diff", "-U0", "--no-color", "--no-renames", base); }
  catch { diff = git("diff", "-U0", "--no-color", "--no-renames", "HEAD~1"); }
  const files = new Set(), hunks = {};
  let cur;
  for (const l of diff.split("\n")) {
    let m;
    if ((m = /^--- (?:a\/(.*)|\/dev\/null)$/.exec(l))) cur = m[1];
    else if ((m = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/.exec(l))) { const f = cur ?? m[1]; files.add(f); if (cur) hunks[f] ??= []; else cur = undefined; }
    else if ((m = /^@@ -(\d+)(?:,(\d+))? /.exec(l)) && cur) {
      const a = +m[1], n = m[2] === undefined ? 1 : +m[2];
      hunks[cur].push(n ? [a, a + n - 1] : [a, a + 1]);
    }
  }
  for (const f of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) files.add(f);
  return { files: [...files], hunks };
}

/** "3-7,9" → [[3,7],[9,9]] */
const ranges = (s) => (s ? s.split(",").map((r) => { const [a, b] = r.split("-").map(Number); return [a, b ?? a]; }) : []);
const overlaps = (rs, hs) => rs.some(([a, b]) => hs.some(([c, d]) => a <= d && c <= b));

/** Names on a "Tests: a, b" line (PR description) */
export const testsLine = (text) => [...(text ?? "").matchAll(/^\s*tests?\s*:\s*(.+)$/gim)].flatMap((m) => m[1].split(/[\s,`]+/)).filter(Boolean);

// Changes that can affect any scenario without showing up in the coverage of one
const GLOBAL = [
  /^package(-lock)?\.json$/, /^packages\/(board|core|host)\/(package\.json|tsconfig[^/]*\.json|vite\.config\.\w+)$/,
  /^packages\/board\/src\/.*\.css$/, /^packages\/board\/src\/fonts\//,
  /^packages\/board\/test\/(harness|runner)\.ts$/, /^packages\/host\/test\/(node-workspace\.ts|fixtures\/)/, /^packages\/board\/test\/(tiers\.json|run-harness\.mjs)$/, /^tools\/test\//,
];
const SRC = /^packages\/(board|core|host)\/src\//;

/**
 * all: { name: defining test file }, change: changes(), impact: loadImpact(), tiers: tiers.json, focus: [names], budgetMs: total scenario time,
 * drifted: files changed between the map's commit and the base (matched by file, not line)
 * → { run: [{ name, why, ms }], deferred: [names], skipped: number, notes: [strings] }
 */
export function pick({ all, change, impact, tiers, focus = [], budgetMs, drifted = [] }) {
  const changed = change.files;
  const names = Object.keys(all).filter((n) => !(tiers.manual ?? []).includes(n));
  const map = impact.map?.scenarios ?? {};
  const ms = (n) => map[n]?.ms ?? DEFAULT_MS;
  const notes = [];
  const why = new Map();
  const add = (n, w) => { if (all[n] && !why.has(n)) why.set(n, w); };
  for (const n of focus) { if (all[n]) add(n, "asked"); else notes.push(`unknown scenario: ${n}`); }
  for (const n of names) if (changed.includes(all[n])) add(n, "test changed");
  if (impact.map) for (const n of names) if (!map[n]) add(n, "new");
  for (const n of impact.failing ?? []) add(n, "failing last night");
  for (const n of tiers.smoke ?? []) add(n, "smoke");

  const global = changed.filter((f) => GLOBAL.some((re) => re.test(f)));
  const seen = new Set(impact.map?.files ?? []);
  const src = changed.filter((f) => SRC.test(f) && !global.includes(f));
  // a new file is reached through the files that import it, which changed too; on its own it can't be placed
  const unmapped = impact.map ? src.filter((f) => !seen.has(f) && (change.hunks[f] || src.every((g) => !seen.has(g)))) : src;
  let affected = [];
  if (global.length || unmapped.length) {
    notes.push(`every scenario may be affected (${[...global, ...unmapped].slice(0, 4).join(", ")}${global.length + unmapped.length > 4 ? ", …" : ""}): quickest first`);
    affected = names.filter((n) => !why.has(n)).sort((a, b) => ms(a) - ms(b) || a.localeCompare(b));
  } else if (src.length) {
    const lines = (n) => map[n]?.lines ?? {};
    const hitFile = (n, f) => {
      const rs = ranges(lines(n)[f]);
      return rs.length > 0 && (drifted.includes(f) || overlaps(rs, change.hunks[f] ?? []));
    };
    const hit = (n) => src.filter((f) => hitFile(n, f)).length;
    const size = (n) => Object.values(lines(n)).reduce((t, s) => t + ranges(s).reduce((u, [a, b]) => u + b - a + 1, 0), 0);
    const spec = (n) => hit(n) / Math.max(1, size(n));
    affected = names.filter((n) => !why.has(n) && hit(n) > 0).sort((a, b) => spec(b) - spec(a) || ms(a) - ms(b) || a.localeCompare(b));
  }
  let used = [...why.keys()].reduce((t, n) => t + ms(n), 0);
  if (used > budgetMs) notes.push(`focus and smoke alone take ${Math.round(used / 1000)} s, over the ${Math.round(budgetMs / 1000)} s budget`);
  const deferred = [];
  for (const n of affected) {
    if (used + ms(n) <= budgetMs) { why.set(n, "affected"); used += ms(n); } else deferred.push(n);
  }
  const run = [...why].map(([name, w]) => ({ name, why: w, ms: ms(name) }));
  return { run, deferred, skipped: names.length - run.length - deferred.length, notes };
}

/** Longest-first split into n shards of about equal time; shard k (1-based) */
export function shard(items, k, n, ms) {
  const bins = Array.from({ length: n }, () => ({ t: 0, items: [] }));
  for (const it of [...items].sort((a, b) => ms(b) - ms(a) || (a.name ?? a).localeCompare(b.name ?? b))) {
    const bin = bins.reduce((m, b) => (b.t < m.t ? b : m));
    bin.items.push(it); bin.t += ms(it);
  }
  return bins[k - 1].items;
}
