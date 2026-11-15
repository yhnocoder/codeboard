// What continuous integration runs (.github/workflows/macos.yml, the accept job): the scenarios in ci.txt (--list
// smoke.txt: a PR's few), grouped by
// what they declare (# storage, # theme, # only: one run.mjs each), with --ci: function only, nothing timed, three
// shots per scenario and side. --shard k/n runs every n-th scenario from the k-th (CI's jobs side by side); other
// arguments go to every run.mjs (--only mac). Exits 1 when a group failed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const argv = process.argv.slice(2);
const listFile = argv.includes("--list") ? argv[argv.indexOf("--list") + 1] : "ci.txt";
const list = fs.readFileSync(path.join(here, listFile), "utf8").split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
const head = (f, key) => new RegExp(`^# ${key}: *(\\S+)`, "m").exec(fs.readFileSync(f, "utf8"))?.[1] ?? "";
const shard = argv.includes("--shard") ? argv[argv.indexOf("--shard") + 1].split("/").map(Number) : [1, 1];
const pass = argv.filter((a, i) => !["--shard", "--list"].includes(a) && !["--shard", "--list"].includes(argv[i - 1]));
const groups = new Map();
for (const s of list.filter((_, i) => i % shard[1] === shard[0] - 1)) {
  const f = path.join(here, "scenarios", s);
  if (!fs.existsSync(f)) throw new Error(`${listFile}: no scenario ${s}`);
  const k = ["storage", "theme", "only"].map((x) => head(f, x)).join("|");
  groups.set(k, [...(groups.get(k) ?? []), f]);
}
let failed = false, first = true;
for (const [k, files] of groups) {
  // written at once: a console.log to a pipe waits for the event loop, which spawnSync holds
  fs.writeSync(1, `\n== ${k.replace(/\|/g, " ").trim() || "default"}: ${files.length} scenarios\n`);
  const args = [path.join(here, "run.mjs"), ...files, "--ci", ...(first ? [] : ["--skip-build"]), ...pass];
  first = false;
  // every group runs, whatever an earlier one did
  if (spawnSync("node", args, { stdio: "inherit" }).status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
