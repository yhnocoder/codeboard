// The nightly run's comment on the "replay-nightly" issue (nightly.yml, publish job), built from the downloaded artifacts:
//   failures      harness (harness-<k>/result.json), e2e (e2e-<k>/e2e.log), perf and Storybook (storybook/result.json); kept in the hidden marker
//                 <!-- nightly-failures: [...] --> that the next night's "Passing again" diff and the PR carry-over read
//   flakes        the flake repeat (repeat/repeat.json, harness.mjs --changed-since --repeat): new or changed scenarios that failed
//                 a repetition. They don't make the run red, and never go into nightly-failures
//   alone         scenarios of the full run that failed beside others and passed only when run alone (alone: true)
// Flakes, alone-passes and a repeat error go into their own marker, <!-- nightly-flaky: {...} -->.
// A comment is due when the set of failures changes, when the repeat found a flake or could not run, or when the alone set changes.
// Usage (github-script): const { nightlyReport } = await import(`${process.env.GITHUB_WORKSPACE}/tools/test/nightly-report.mjs`)
import * as fs from "node:fs";

const json = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const first = (x) => (x.fails?.[0] || x.error || "").split("\n")[0].slice(0, 160);

/**
 * dir: the artifacts; jobs: the publish job's `needs`; comments: the issue's comment bodies, oldest first; run: the run's URL;
 * sha: the commit (short) → { fails, flaky, due, body }
 */
export function nightlyReport({ dir, jobs, comments, run, sha }) {
  const fails = [], alone = [];
  const fullFailing = new Set();
  for (const k of [1, 2]) {
    const r = json(`${dir}/harness-${k}/result.json`);
    if (!r) { fails.push(`harness ${k}/2: no results`); continue; }
    for (const x of r.results.filter((x) => !x.ok)) { fails.push(`harness ${x.name}: ${first(x)}`); fullFailing.add(x.name); }
    for (const x of r.results.filter((x) => x.alone)) alone.push(x.name);
  }
  for (const k of [1, 2, 3]) {
    const log = read(`${dir}/e2e-${k}/e2e.log`);
    const bad = log.split("\n").filter((l) => /^✗/.test(l));
    if (bad.length) bad.forEach((l) => fails.push(`e2e ${k}/3: ${l.slice(2, 160)}`));
    else if (jobs.e2e?.result !== "success" && !/all passed/.test(log)) fails.push(`e2e ${k}/3: failed (see the run log)`);
  }
  if (jobs.perf?.result === "failure") fails.push(`perf: ${read(`${dir}/perf/summary.md`).split("\n").find((l) => /❌|regress/i.test(l))?.slice(0, 160) || "regression (see the run log)"}`);

  const sb = json(`${dir}/storybook/result.json`);
  if (!sb) fails.push(`storybook: ${jobs.storybook?.result === "success" ? "no results" : "failed before any story ran (see the run log)"}`);
  else for (const x of sb.failures) fails.push(`storybook ${x.id}: ${first({ error: x.error })}`);

  // The flake repeat. A scenario failing in the full run is a failure above, not a flake.
  const rep = json(`${dir}/repeat/repeat.json`);
  const repeatError = !rep ? `no results (repeat job: ${jobs.repeat?.result ?? "did not run"})` : rep.error ?? null;
  const repeated = rep?.results ?? [];
  const flakes = repeated.filter((x) => !x.ok && !fullFailing.has(x.name));
  const alsoFull = repeated.filter((x) => !x.ok && fullFailing.has(x.name)).map((x) => x.name);

  // Last night's markers
  const mark = (re) => [...comments].reverse().map((c) => re.exec(c || "")).find(Boolean);
  const lastFails = mark(/<!-- nightly-failures: (.*) -->/);
  const lastFlaky = mark(/<!-- nightly-flaky: (.*) -->/);
  const before = new Set(lastFails ? JSON.parse(lastFails[1]) : []);
  const beforeAlone = lastFlaky ? JSON.parse(lastFlaky[1]).alone ?? [] : [];
  const key = (f) => f.split(":")[0];
  const same = fails.length === before.size && fails.every((f) => [...before].some((b) => key(b) === key(f)));
  const aloneSame = alone.length === beforeAlone.length && alone.every((n) => beforeAlone.includes(n));
  const due = !same || flakes.length > 0 || !!repeatError || !aloneSame;
  const flaky = { flakes: flakes.map((x) => x.name), alone, ...(repeatError ? { error: repeatError } : {}) };

  const fixed = [...before].filter((b) => !fails.some((f) => key(f) === key(b)));
  const n = rep?.repeat ?? 3;
  const repeatLines = repeatError ? [`- ❗ **error**: ${repeatError}`]
    : !repeated.length ? [`- no test file changed since ${rep.base?.slice(0, 7)}: nothing repeated`]
    : [
      ...(flakes.length
        ? flakes.map((x) => `- ${x.name}: failed ${x.failed ?? "?"} of ${x.runs ?? n} runs: ${first(x)}`)
        : [`- none: ${repeated.length} new or changed scenarios since ${rep.base?.slice(0, 7)} passed ${n} times each`]),
      ...(alsoFull.length ? [`- also failing in the full run (listed above, not counted here): ${alsoFull.join(", ")}`] : []),
      ...(rep.deferred?.length ? [`- not repeated (over the time cap): ${rep.deferred.join(", ")}`] : []),
    ];
  const body = [
    fails.length ? `❌ **Nightly: ${fails.length} failing** on main @ ${sha}`
      : before.size ? `✅ **Nightly: everything passes again** on main @ ${sha}` : `✅ **Nightly: no failures** on main @ ${sha}`,
    `[Run log](${run}) · harness scenarios failing here are run on every PR until they pass`, "",
    ...fails.map((f) => `- ${[...before].some((b) => key(b) === key(f)) ? "" : "🆕 "}${f}`),
    ...(fixed.length ? ["", "Passing again:", ...fixed.map((f) => `- ${key(f)}`)] : []), "",
    `### ⚠️ Flakes (${flakes.length})`,
    `New or changed scenarios, each run ${n} times on several workers after the full run; any failed run is a flake. Flakes don't make the run red and are not carried over to PRs.`,
    ...repeatLines, "",
    `### Passed only when run alone (${alone.length})`,
    ...(alone.length ? [`Failed beside other scenarios in the full run, passed when run again on their own (counted as passed):`, ...alone.map((a) => `- ${a}`)] : ["- none"]), "",
    `<!-- nightly-failures: ${JSON.stringify(fails)} -->`,
    `<!-- nightly-flaky: ${JSON.stringify(flaky)} -->`,
  ].join("\n").replace(/\n{3,}/g, "\n\n");
  return { fails, flaky, due, body };
}
