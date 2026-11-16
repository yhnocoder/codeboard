// The acceptance scenarios a pull request's accept (smoke) job runs (.github/workflows/macos.yml): smoke.txt's, then
// the scenario files the PR added or changed (git diff of the merge commit against its first parent, the base), then
// the scenarios its description names on lines "Accept: name, name" (PR_BODY), each once. A changed scenario that
// ci.txt leaves out is not added, since it is left out for not holding on CI's Macs; naming it still runs it. More than
// 20 changed scenario files is a mechanical change, and none of them is added: the regular full run covers them.
// Writes apps/macos/.build-ci/accept-list.txt, which ci.mjs reads as --list ../../.build-ci/accept-list.txt, and says
// what it added and why (also in $GITHUB_STEP_SUMMARY). A name the description gives that is not a scenario fails it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { namesIn, shown } from "./description.mjs";

const app = path.resolve(import.meta.dirname, "../..");
const accept = path.join(app, "tools/accept");
const scenarios = "tools/accept/scenarios";
const out = path.join(app, ".build-ci/accept-list.txt");
const mostChanged = 20;
// a scenario's name as the lists write it, in a folder of scenarios or not: no "..", no characters a shell or the log reads
const scenarioName = /^(?:[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/;

function fail(message) {
  process.stderr.write(`accept-list.mjs: ${message}\n`);
  process.exit(1);
}

const list = (file) =>
  fs
    .readFileSync(path.join(accept, file), "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
const smoke = list("smoke.txt");
const ci = new Set(list("ci.txt"));
const isScenario = (name) =>
  scenarioName.test(name) && fs.statSync(path.join(app, scenarios, `${name}.txt`), { throwIfNoEntry: false })?.isFile();

let diff;
try {
  diff = execFileSync(
    "git",
    ["-C", app, "diff", "-z", "--name-only", "--diff-filter=AMR", "--relative", "HEAD^1", "HEAD", "--", scenarios],
    { encoding: "utf8" },
  );
} catch {
  fail("cannot compare HEAD with its first parent (the checkout needs fetch-depth: 2)");
}
const changed = diff
  .split("\0")
  .filter((f) => f.endsWith(".txt"))
  .map((f) => path.posix.relative(scenarios, f));
const odd = changed.filter((f) => !scenarioName.test(f.replace(/\.txt$/, "")));
if (odd.length) fail(`changed scenario files with names a scenario cannot have: ${odd.map(shown).join(", ")}`);

const named = namesIn(process.env.PR_BODY, "Accept");
const bad = named.filter((n) => !isScenario(n.replace(/\.txt$/, "")));
if (bad.length)
  fail(
    `the description's Accept: lines name ${bad.map(shown).join(", ")}, not a scenario in apps/macos/${scenarios} ` +
      "(written like arrow-read or b1/b1-open, with or without .txt)",
  );

const added = [];
const report = [];
const take = (names, why) => {
  const fresh = names.filter((n) => !smoke.includes(n) && !added.includes(n));
  const already = names.filter((n) => !fresh.includes(n));
  added.push(...new Set(fresh));
  if (names.length)
    report.push(
      `${why}: ${[...new Set(fresh)].join(", ") || "none new"}` +
        (already.length ? ` (already listed: ${[...new Set(already)].join(", ")})` : ""),
    );
};
if (changed.length > mostChanged)
  report.push(
    `${changed.length} scenario files changed, more than ${mostChanged}: none of them added (the regular full run covers them)`,
  );
else {
  take(
    changed.filter((n) => ci.has(n)),
    "changed",
  );
  const left = changed.filter((n) => !ci.has(n));
  if (left.length)
    report.push(
      `changed but not in ci.txt, so not added (list them in ci.txt, or name them on an Accept: line): ${left.join(", ")}`,
    );
}
take(
  named.map((n) => n.replace(/(\.txt)?$/, ".txt")),
  "named in the description",
);
if (!added.length && !report.length) report.push("nothing added");

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${[...smoke, ...added].join("\n")}\n`);
const summary = [
  `Acceptance scenarios: the ${smoke.length} of smoke.txt and ${added.length} more`,
  ...report.map((r) => `  ${r}`),
  `  list: ${path.relative(path.resolve(app, "../.."), out)}`,
].join("\n");
process.stdout.write(`${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Mac app acceptance scenarios\n\n\`\`\`\n${summary}\n\`\`\`\n`,
  );
