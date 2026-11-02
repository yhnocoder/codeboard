// The CI section of a PR description (.github/workflows/ci.yml, report job): job results, the harness (what ran, why, what failed,
// what passed only when run alone, what was left to the regular run), perf, the UI audit and the e2e screenshot diff.
// Usage (github-script): const { ciReport, withSection } = await import(`${process.env.GITHUB_WORKSPACE}/tools/test/ci-report.mjs`)
import * as fs from "node:fs";
import { createRequire } from "node:module";

const { report: auditReport } = createRequire(import.meta.url)("../review/audit.cjs");

const json = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const START = "<!-- ci-screenshots:start -->",
  END = "<!-- ci-screenshots:end -->";

/** Harness lines: the plan (harness-plan/plan.json, tools/test/pick.mjs) against each job's harness-<k>/result.json */
export function harnessLines(dir) {
  const plan = json(`${dir}/harness-plan/plan.json`, {});
  const hr = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((d) => /^harness-\d+$/.test(d))
    .map((d) => json(`${dir}/${d}/result.json`, {}))
    .filter((x) => x.results);
  if (!hr.length) return ["**Harness**: no results."];
  const res = hr.flatMap((x) => x.results),
    deferred = plan.deferred ?? [];
  const by = Object.entries(Object.groupBy(res, (r) => r.why))
    .map(([w, xs]) => `${xs.length} ${w}`)
    .join(", ");
  const known = [...new Set(res.flatMap((r) => r.known ?? []))];
  const alone = res.filter((r) => r.alone);
  const missing = (plan.run ?? []).filter((x) => !res.some((r) => r.name === x.name)).map((x) => x.name);
  const first = (r) => (r.fails?.[0] || r.error || "").split("\n")[0].slice(0, 200);
  return [
    `**Harness**: ${res.length} scenarios (${by}), ${res.filter((r) => !r.ok).length} failed, on ${hr.length} of ${plan.shards ?? "?"} jobs` +
      (deferred.length ? `, ${deferred.length} deferred to the regular run` : ""),
    ...res.filter((r) => !r.ok).map((r) => `- ❌ ${r.name}: ${first(r)}`),
    ...(missing.length ? [`- ❌ picked but no result (a harness job failed before reporting): ${missing.length}`] : []),
    ...(known.length ? [`- known failures (tiers.json): ${known.length}`] : []),
    // counted as passed, but each one failed beside other scenarios: a race or a timing check that only shows under load
    ...alone.map(
      (r) => `- ⚠️ ${r.name} passed only when run alone; beside others: ${(r.parallelFails?.[0] ?? "?").slice(0, 200)}`,
    ),
    ...(plan.areas?.length ? [`- area groups: ${plan.areas.map((g) => g.name).join(", ")}`] : []),
    ...(plan.notes ?? []).filter((n) => /^(the scenarios this change needs|group )/.test(n)).map((n) => `- ⚠️ ${n}`),
    ...(deferred.length
      ? ["", `<details><summary>Deferred (extra coverage that didn't fit)</summary>${deferred.join(", ")}</details>`]
      : []),
  ];
}

/**
 * dir: the downloaded artifacts; jobs: the report job's `needs`; run: the run's URL; sha: the PR head (short); shots: the file
 * with the e2e screenshot diff (publish-shots.sh's Markdown, missing when there were no screenshots) → the section, between its markers
 */
export function ciReport({ dir, jobs, run, sha, shots }) {
  const mark = (v) => (v.result === "success" ? "✅" : v.result === "skipped" ? "–" : "❌");
  return [
    START,
    "## CI report",
    "",
    `Commit ${sha} · [Run log](${run}) · ${Object.entries(jobs)
      .map(([k, v]) => `${k} ${mark(v)}`)
      .join(" · ")}`,
    "",
    ...harnessLines(dir),
    "",
    read(`${dir}/perf/summary.md`) ||
      (jobs.perf?.result === "success"
        ? "**Performance**: skipped, no change to code the benchmarks run."
        : "**Performance**: no results."),
    "",
    ...auditReport(json(`${dir}/e2e/audit.json`, []), "UI audit"),
    "",
    "<details><summary>e2e screenshots, vs target branch</summary>",
    "",
    (shots && read(shots)) || "No screenshots.",
    "</details>",
    END,
  ].join("\n");
}

/** The PR description with its CI section replaced, or added at the end */
export function withSection(body, section) {
  const re = new RegExp(`${START}[\\s\\S]*${END}`);
  // a function replacement: "$&" or "$1" in the section are text, not patterns
  return re.test(body ?? "") ? body.replace(re, () => section) : `${body ?? ""}\n\n${section}`;
}
