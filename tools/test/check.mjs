// npm run check: the local test run, about 90 seconds. See TESTING.md.
//   1. the @yhnocoder/markdown build (packages/markdown/dist, a few seconds), which the board, its typecheck, the package's own
//      tests and the demo all use; then typecheck, unit tests (core, markdown, board, host, extension) and the Markdown demo
//      (examples/markdown-demo, built and run in Chromium) side by side with the board build, which runs only when its
//      sources changed since the last one
//   2. as soon as the board is built (the scenarios need nothing else), the harness scenarios this change needs
//      (tools/test/pick.mjs), compared with origin/main, several at a time, within what is left of the 90 seconds; what doesn't
//      fit is listed as left to CI
// Usage: npm run check [-- <scenario…>] [-- --all] [-- --base=<ref>] [-- --budget=<seconds of harness>]
//   scenario names are always run (the problem being worked on); --all runs every scenario, with no time limit
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const focus = args.filter((a) => !a.startsWith("--"));
const LIMIT = 90, t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);

function run(name, cmd, a, env = {}) {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(cmd, a, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      console.log(`${code ? "✗" : "✓"} ${name} ${Math.round((Date.now() - t) / 1000)} s`);
      if (code) process.stdout.write(out.split("\n").slice(-60).join("\n") + "\n");
      resolve(code === 0);
    });
  });
}

// The board build takes most of a minute: skip it when nothing it is built from changed since the last one
function buildHash() {
  const h = createHash("sha1");
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "packages/board/src", "packages/board/vite.config.ts", "packages/board/package.json", "packages/markdown/src", "packages/markdown/package.json", "packages/markdown/vite.config.ts", "packages/markdown/tsconfig.json", "packages/markdown/tsconfig.build.json", "packages/analysis/src", "packages/core/src", "package-lock.json"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files.sort()) { h.update(f); try { h.update(fs.readFileSync(path.join(REPO, f))); } catch { /* deleted */ } }
  return h.digest("hex");
}
// first and alone: everything below reads packages/markdown/dist, and the build empties it before writing
if (!(await run("build @yhnocoder/markdown", "npm", ["run", "build", "-w", "@yhnocoder/markdown"]))) { console.log("markdown build failed: nothing else run"); process.exit(1); }

const stamp = path.join(REPO, "extensions/vscode/media/board/.build-hash");
const hash = buildHash();
const fresh = fs.existsSync(path.join(REPO, "extensions/vscode/media/board/board.js")) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === hash;
const build = fresh ? run("build (extension only; board unchanged)", "npm", ["run", "build", "-w", "codeboard-vscode"])
  : run("build", "sh", ["-c", "npm run build -w @codeboard/board && npm run build -w codeboard-vscode"]).then((ok) => { if (ok) fs.writeFileSync(stamp, hash); return ok; });

const first = Promise.all([
  run("typecheck", "npm", ["run", "typecheck"]),
  run("unit tests", "npm", ["test"]),
  run("markdown demo", "npm", ["test", "-w", "@codeboard/markdown-demo"]),
]);
if (!(await build)) { console.log("build failed: no harness run"); await first; process.exit(1); }

let base = opt("base");
if (!base) {
  try { execFileSync("git", ["fetch", "-q", "origin", "main"], { cwd: REPO, stdio: "ignore", timeout: 15000 }); } catch { /* offline: the last fetched main */ }
  try { base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { console.log("no merge base with origin/main (fetch it, or pass --base=<ref>): no harness run"); await first; process.exit(1); }
}
const workers = Math.min(4, os.availableParallelism());
// Harness budget: what is left of the 90 seconds, minus a margin for start-up and the slowest scenario finishing last, times the
// scenario seconds this machine got through per second of wall time in the last check (the nightly estimates come from another
// machine, and here the scenarios share the CPU with typecheck and unit tests); 0.8 per worker before the first run
const JSON_OUT = path.join(REPO, "test-out/check/harness.json");
const rate = (() => {
  try {
    const { planned, wall } = JSON.parse(fs.readFileSync(JSON_OUT, "utf8"));
    if (planned > 0 && wall > 10) return Math.min(workers * 1.2, Math.max(workers * 0.4, planned / wall));
  } catch { /* no earlier check */ }
  return workers * 0.8;
})();
const budget = opt("budget") ?? Math.max(30, Math.round((LIMIT - secs() - 25) * rate));
const harness = args.includes("--all") ? [...focus] : ["--select", `--base=${base}`, `--budget=${budget}`, "--defer-to=CI", ...(focus.length ? [`--focus=${focus.join(",")}`] : [])];
console.log(`harness: ${args.includes("--all") ? "every scenario" : `changes since ${base.slice(0, 7)}, budget ${budget} s of scenario time`} on ${workers} workers`);
// The harness at a lower priority: the unit tests are the longest of the jobs it shares the CPU with, and a harness that uses up
// any CPU left over finishes no later, while unit tests starved by its workers (63 s instead of 20 s on 4 cores) end the run last
const ok = await new Promise((resolve) => {
  const p = spawn("nice", ["-n", "10", "node", "tools/test/harness.mjs", ...harness, `--workers=${workers}`, `--json=${JSON_OUT}`], { cwd: REPO, stdio: "inherit" });
  p.on("close", (code) => resolve(code === 0));
});
const all = (await first).every(Boolean) && ok;
console.log(`\n${all ? "✓ all passed" : "✗ failures above"} in ${secs()} s${secs() > LIMIT ? ` (over the ${LIMIT} s target)` : ""}`);
process.exit(all ? 0 : 1);
