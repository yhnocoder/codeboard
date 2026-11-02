// Whether a change touches code the perf benchmarks run (packages/board/test/tiers.json "perf"): the PR CI perf job runs only then.
// Usage: node tools/test/perf-need.mjs <base commit>  → prints run=true or run=false (a GitHub step output line) and lists the
// files that decide it on stderr. Any other exit than 0 is an error, never "skip": a base that git cannot diff against (a bad or
// missing BASE_SHA) must fail the job, not pass it without perf.
// No dependencies: it runs before npm ci.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { perfFiles } from "./areas.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const base = process.argv[2];
if (!base) {
  console.error("usage: node tools/test/perf-need.mjs <base commit>");
  process.exit(2);
}
const tiers = JSON.parse(fs.readFileSync(path.join(REPO, "packages/board/test/tiers.json"), "utf8"));
let changed;
try {
  changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch (e) {
  console.error(`perf-need: cannot diff against the base ${base}: ${e.message}`);
  process.exit(2);
}
const hit = perfFiles(changed, tiers);
for (const f of hit) console.error(f);
console.log(`run=${hit.length > 0}`);
