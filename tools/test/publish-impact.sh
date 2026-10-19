#!/bin/bash
# For the nightly CI run: merge the harness results of all shards into the impact map that tools/test/pick.mjs reads, and push it
# to the ci-screenshots branch under impact/ (harness.json: each scenario's time and the source lines it ran; failing.json).
# Usage: tools/test/publish-impact.sh <dir with harness-*/result.json>
# Needs: run from the repo root with a pushable origin. Keeps the old map when a shard has no results.
set -e
DIR=$1; ROOT=$(pwd); WT=$ROOT/.ci-impact; NEW=$ROOT/test-out/impact-new
mkdir -p "$NEW"
node - "$DIR" "$NEW" <<'JS'
const fs = require("fs"), path = require("path");
const [dir, out] = process.argv.slice(2);
const shards = fs.readdirSync(dir).filter((d) => /^harness-\d+$/.test(d)).map((d) => path.join(dir, d, "result.json"));
const runs = shards.filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
if (!runs.length || runs.length < shards.length) { console.log("a shard has no results: impact map not updated"); process.exit(0); }
const results = runs.flatMap((r) => r.results);
const scenarios = {}, files = new Set();
for (const r of results) { scenarios[r.name] = { ms: r.ms, lines: r.lines ?? {} }; for (const f of Object.keys(r.lines ?? {})) files.add(f); }
const map = { generated: new Date().toISOString().slice(0, 16) + "Z", commit: process.env.GITHUB_SHA ?? "", scenarios, files: [...files].sort() };
fs.writeFileSync(path.join(out, "harness.json"), JSON.stringify(map));
fs.writeFileSync(path.join(out, "failing.json"), JSON.stringify(results.filter((r) => !r.ok).map((r) => r.name).sort()));
console.log(`impact map: ${results.length} scenarios, ${files.size} source files, ${results.filter((r) => !r.ok).length} failing`);
JS
[ -f "$NEW/harness.json" ] || exit 0
git config user.name "codeboard-ci"; git config user.email "ci@users.noreply.github.com"
rm -rf "$WT"
if git fetch -q --depth 1 origin ci-screenshots; then git worktree add -q "$WT" FETCH_HEAD
else git worktree add -q --detach "$WT"; (cd "$WT" && git checkout -q --orphan ci-screenshots && git rm -rqf . ); fi
mkdir -p "$WT/impact"; cp "$NEW"/*.json "$WT/impact/"
cd "$WT"; git add -A impact
if ! git diff --cached --quiet; then
  git commit -qm "impact map @ ${GITHUB_SHA:0:7}"
  for i in 1 2 3 4; do git push -q origin HEAD:ci-screenshots && break
    sleep $((2 ** i)); git fetch -q origin ci-screenshots && git rebase -q FETCH_HEAD || true; done
fi
cd "$ROOT"; git worktree remove --force "$WT"
