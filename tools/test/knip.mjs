// npm run lint's dead-code part: knip (knip.json) over the whole repo, compared with tools/test/knip-known.txt, the findings there were
// when knip came in. A new finding fails, and so does a listed one that is gone (delete its line, so the list keeps up).
// Usage: node tools/test/knip.mjs [--write] (--write: rewrite the list with what knip finds now)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const KNOWN = path.join(REPO, "tools/test/knip-known.txt");

const r = spawnSync("npx", ["knip", "--no-progress", "--reporter", "json"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
let issues;
try { ({ issues } = JSON.parse(r.stdout)); } catch { process.stdout.write(r.stdout + r.stderr); console.log("knip did not run"); process.exit(1); }
// one line per finding: "<kind> <file> <name>". Tests and stories are entry files whose exports are for their runner (knip.json's
// includeEntryExports also checks the packages' own entries, src included), so unused exports there are not findings
const runnerFile = (f) => /(^|\/)(test|stories|\.storybook)\//.test(f);
const found = issues
  .flatMap((i) => Object.entries(i).flatMap(([kind, v]) => (Array.isArray(v) && !((kind === "exports" || kind === "types") && runnerFile(i.file)) ? v.map((x) => `${kind} ${i.file}${x.name ? ` ${x.name}` : ""}`) : [])))
  .sort();

if (process.argv.includes("--write")) {
  fs.writeFileSync(KNOWN, `# knip findings to clear (tools/test/knip.mjs): <kind> <file> <name>\n${found.join("\n")}\n`);
  console.log(`${found.length} findings written to ${path.relative(REPO, KNOWN)}`);
  process.exit(0);
}
const known = fs.readFileSync(KNOWN, "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
const added = found.filter((f) => !known.includes(f)), gone = known.filter((k) => !found.includes(k));
for (const f of added) console.log(`new: ${f}`);
for (const k of gone) console.log(`fixed, delete its line in tools/test/knip-known.txt: ${k}`);
if (added.length || gone.length) process.exit(1);
console.log(`knip: nothing new (${known.length} known findings left)`);
