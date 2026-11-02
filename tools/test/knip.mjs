// npm run lint's dead-code part: knip (knip.json) over the whole repo. Any finding fails.
// Usage: node tools/test/knip.mjs
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

const r = spawnSync("npx", ["knip", "--no-progress", "--reporter", "json"], {
  cwd: REPO,
  encoding: "utf8",
  maxBuffer: 64 << 20,
});
let issues;
try {
  ({ issues } = JSON.parse(r.stdout));
} catch {
  process.stdout.write(r.stdout + r.stderr);
  console.log("knip did not run");
  process.exit(1);
}
// one line per finding: "<kind> <file> <name>". Tests and stories are entry files whose exports are for their runner (knip.json's
// includeEntryExports also checks the packages' own entries, src included), so unused exports there are not findings
const runnerFile = (f) => /(^|\/)(test|stories|\.storybook)\//.test(f);
const found = issues
  .flatMap((i) =>
    Object.entries(i).flatMap(([kind, v]) =>
      Array.isArray(v) && !((kind === "exports" || kind === "types") && runnerFile(i.file))
        ? v.map((x) => `${kind} ${i.file}${x.name ? ` ${x.name}` : ""}`)
        : [],
    ),
  )
  .sort();

for (const f of found) console.log(`found: ${f}`);
if (found.length) process.exit(1);
console.log("knip: nothing found");
