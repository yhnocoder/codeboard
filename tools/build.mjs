// npm run build: builds a workspace after the workspaces it depends on (dependencies and devDependencies, transitively), in
// that order, each with its own build script; workspaces without one (analysis, core, host: used from source) are skipped.
// Usage: node tools/build.mjs [--deps] <workspace name>…   (--deps: only what the named ones depend on)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const root = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const dirs = root.workspaces.flatMap((w) =>
  w.endsWith("/*")
    ? fs
        .readdirSync(path.join(REPO, w.slice(0, -2)), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(w.slice(0, -2), e.name))
    : [w],
);
const pkgs = new Map();
for (const d of dirs) {
  const f = path.join(REPO, d, "package.json");
  if (fs.existsSync(f)) {
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    pkgs.set(p.name, p);
  }
}

const args = process.argv.slice(2);
const depsOnly = args.includes("--deps");
const names = args.filter((a) => a !== "--deps");
for (const n of names) if (!pkgs.has(n)) throw new Error(`build: no workspace named ${n}`);

const order = [];
const seen = new Set();
function visit(name, chain) {
  if (chain.includes(name)) throw new Error(`build: workspaces depend on each other: ${[...chain, name].join(" → ")}`);
  if (seen.has(name)) return;
  const p = pkgs.get(name);
  for (const d of Object.keys({ ...p.dependencies, ...p.devDependencies })) if (pkgs.has(d)) visit(d, [...chain, name]);
  seen.add(name);
  order.push(name);
}
for (const n of names) visit(n, []);

for (const n of order) {
  if (depsOnly && names.includes(n)) continue;
  if (!pkgs.get(n).scripts?.build) continue;
  console.log(`\n> build ${n}`);
  const r = spawnSync("npm", ["run", "build", "-w", n], { cwd: REPO, stdio: "inherit" });
  if (r.status) process.exit(r.status ?? 1);
}
