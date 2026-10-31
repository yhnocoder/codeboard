// The report of a scheduled regular run (.github/workflows/regular.yml, every 6 hours) for the results issue (#19):
//   failures      harness (harness-<k>/result.json), e2e (e2e-<k>/e2e.log), perf and Storybook (storybook/result.json); kept in the hidden marker
//                 <!-- regular-failures: [...] --> that the next run's "Passing again" diff and the PR carry-over read
// Flakes, alone-passes and a repeat error go into their own marker, <!-- regular-flaky: {...} -->.
// Area groups (tiers.json) over their time limits, timed by this run, go into <!-- regular-groups: [...] -->: npm run check runs
// each touched group whole, so a group that grew is fixed in tiers.json, not cut at run time.
// A comment is due when the set of failures changes, when the repeat found a flake, when its error changes (a repeat that keeps
// failing the same way is reported once, not on every run, four a day), when the alone set changes, or when the set of groups over
// their limits changes. A flake is reported once: the next run repeats only what changed since this one.
// Usage (github-script): const { regularReport } = await import(`${process.env.GITHUB_WORKSPACE}/tools/test/regular-report.mjs`)
import * as fs from "node:fs";
import { groupTimes } from "./areas.mjs";

const json = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const first = (x) => (x.fails?.[0] || x.error || "").split("\n")[0].slice(0, 160);

/**
 * dir: the artifacts; jobs: the publish job's `needs`; comments: the issue's comment bodies, oldest first; run: the run's URL;
 * sha: the commit (short); tiers: packages/board/test/tiers.json → { fails, flaky, groups, due, body }
 */
export function regularReport({ dir, jobs, comments, run, sha, tiers }) {
  const fails = [],
    alone = [];
  const fullFailing = new Set();
  const took = new Map();
  for (const k of [1, 2]) {
    const r = json(`${dir}/harness-${k}/result.json`);
    if (!r) {
      fails.push(`harness ${k}/2: no results`);
      continue;
    }
    for (const x of r.results.filter((x) => !x.ok)) {
      fails.push(`harness ${x.name}: ${first(x)}`);
      fullFailing.add(x.name);
    }
    for (const x of r.results.filter((x) => x.alone)) alone.push(x.name);
    for (const x of r.results) took.set(x.name, x.ms);
  }
  // timed only when both halves of the full run reported: a missing half would make every group look short
  const groups =
    tiers && took.size && !fails.some((f) => /^harness \d\/2: no results/.test(f))
      ? groupTimes(tiers, (n) => took.get(n) ?? 0).over
      : [];
  for (const k of [1, 2, 3]) {
    const log = read(`${dir}/e2e-${k}/e2e.log`);
    const bad = log.split("\n").filter((l) => /^✗/.test(l));
    if (bad.length) bad.forEach((l) => fails.push(`e2e ${k}/3: ${l.slice(2, 160)}`));
    else if (jobs.e2e?.result !== "success" && !/all passed/.test(log))
      fails.push(`e2e ${k}/3: failed (see the run log)`);
  }
  if (jobs.perf?.result === "failure")
    fails.push(
      `perf: ${
        read(`${dir}/perf/summary.md`)
          .split("\n")
          .find((l) => /❌|regress/i.test(l))
          ?.slice(0, 160) || "regression (see the run log)"
      }`,
    );

  const sb = json(`${dir}/storybook/result.json`);
  if (!sb)
    fails.push(
      `storybook: ${jobs.storybook?.result === "success" ? "no results" : "failed before any story ran (see the run log)"}`,
    );
  else for (const x of sb.failures) fails.push(`storybook ${x.id}: ${first({ error: x.error })}`);

  // The flake repeat. A scenario failing in the full run is a failure above, not a flake.
  const rep = json(`${dir}/repeat/repeat.json`);
  const repeatError = !rep ? `no results (repeat job: ${jobs.repeat?.result ?? "did not run"})` : (rep.error ?? null);
  const repeated = rep?.results ?? [];
  const flakes = repeated.filter((x) => !x.ok && !fullFailing.has(x.name));
  const alsoFull = repeated.filter((x) => !x.ok && fullFailing.has(x.name)).map((x) => x.name);

  const mark = (re) =>
    [...comments]
      .reverse()
      .map((c) => re.exec(c || ""))
      .find(Boolean);
  const lastFails = mark(/<!-- regular-failures: (.*) -->/);
  const lastFlaky = mark(/<!-- regular-flaky: (.*) -->/);
  const lastGroups = mark(/<!-- regular-groups: (.*) -->/);
  const before = new Set(lastFails ? JSON.parse(lastFails[1]) : []);
  const beforeFlaky = lastFlaky ? JSON.parse(lastFlaky[1]) : {};
  const beforeAlone = beforeFlaky.alone ?? [];
  const key = (f) => f.split(":")[0];
  const same = fails.length === before.size && fails.every((f) => [...before].some((b) => key(b) === key(f)));
  const aloneSame = alone.length === beforeAlone.length && alone.every((n) => beforeAlone.includes(n));
  const beforeGroups = lastGroups ? JSON.parse(lastGroups[1]).map(key) : [];
  const groupsSame = groups.length === beforeGroups.length && groups.every((g) => beforeGroups.includes(key(g)));
  const errorSame = (repeatError ?? null) === (beforeFlaky.error ?? null);
  const due = !same || flakes.length > 0 || !errorSame || !aloneSame || !groupsSame;
  const flaky = { flakes: flakes.map((x) => x.name), alone, ...(repeatError ? { error: repeatError } : {}) };

  const fixed = [...before].filter((b) => !fails.some((f) => key(f) === key(b)));
  const n = rep?.repeat ?? 3;
  const repeatLines = repeatError
    ? [`- ❗ **error**: ${repeatError}`]
    : !repeated.length
      ? [`- no test file changed since ${rep.base?.slice(0, 7)}: nothing repeated`]
      : [
          ...(flakes.length
            ? flakes.map((x) => `- ${x.name}: failed ${x.failed ?? "?"} of ${x.runs ?? n} runs: ${first(x)}`)
            : [
                `- none: ${repeated.length} new or changed scenarios since ${rep.base?.slice(0, 7)} passed ${n} times each`,
              ]),
          ...(alsoFull.length
            ? [`- also failing in the full run (listed above, not counted here): ${alsoFull.join(", ")}`]
            : []),
          ...(rep.deferred?.length ? [`- not repeated (over the time cap): ${rep.deferred.join(", ")}`] : []),
        ];
  const body = [
    fails.length
      ? `❌ **Regular run: ${fails.length} failing** on main @ ${sha}`
      : before.size
        ? `✅ **Regular run: everything passes again** on main @ ${sha}`
        : `✅ **Regular run: no failures** on main @ ${sha}`,
    `[Run log](${run}) · harness scenarios failing here are run on every PR until they pass`,
    "",
    ...fails.map((f) => `- ${[...before].some((b) => key(b) === key(f)) ? "" : "🆕 "}${f}`),
    ...(fixed.length ? ["", "Passing again:", ...fixed.map((f) => `- ${key(f)}`)] : []),
    "",
    `### ⚠️ Flakes (${flakes.length})`,
    `New or changed scenarios, each run ${n} times on several workers after the full run; any failed run is a flake. Flakes don't make the run red and are not carried over to PRs.`,
    ...repeatLines,
    "",
    `### Passed only when run alone (${alone.length})`,
    ...(alone.length
      ? [
          `Failed beside other scenarios in the full run, passed when run again on their own (counted as passed):`,
          ...alone.map((a) => `- ${a}`),
        ]
      : ["- none"]),
    "",
    `### Area groups over their time limits (${groups.length})`,
    `npm run check runs every group a change touches, whole: a group over its limit (tiers.json limits, timed by this run) gets trimmed there.`,
    ...(groups.length ? groups.map((g) => `- ${g}`) : ["- none"]),
    "",
    `<!-- regular-failures: ${JSON.stringify(fails)} -->`,
    `<!-- regular-flaky: ${JSON.stringify(flaky)} -->`,
    `<!-- regular-groups: ${JSON.stringify(groups)} -->`,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { fails, flaky, groups, due, body };
}
