#!/bin/bash
# For CI: diff this e2e run's screenshots against the baseline, push the result to the ci-screenshots branch, and write Markdown for the PR description.
# Usage: publish-shots.sh <this run's screenshot dir> <storage key, e.g. pr/12 or branches/main> <baseline: a key such as branches/main, or a local dir> [summary.md path]
# Needs: GITHUB_REPOSITORY; run from the repo root with a pushable origin. Writes the summary to test-out/shots-summary.md unless a path is given
set -e
SHOTS=$1; KEY=$2; BASE=$3
ROOT=$(pwd); WT=$ROOT/.ci-shots; OUTMD=${4:-$ROOT/test-out/shots-summary.md}; DIFF=$ROOT/test-out/shots-diff-${KEY//\//-}
git config user.name "codeboard-ci"; git config user.email "ci@users.noreply.github.com"
rm -rf "$WT"
if git fetch -q --depth 1 origin ci-screenshots; then git worktree add -q "$WT" FETCH_HEAD
else git worktree add -q --detach "$WT"; (cd "$WT" && git checkout -q --orphan ci-screenshots && git rm -rqf . ); fi
# Fall back to this key's previous shots as the baseline: on a PR's first run, when base has no screenshots yet, at least compare with our own last push
# A local dir as baseline: screenshots of the base commit taken in this same CI run
if [ -d "$BASE" ]; then B=$BASE; else B="$WT/$BASE/shots"; [ -d "$B" ] || B="$WT/$KEY/shots"; fi
rm -rf "$DIFF"
node "$ROOT/tools/review/shotdiff.mjs" "$B" "$SHOTS" "$DIFF" \
  "https://github.com/$GITHUB_REPOSITORY/blob/ci-screenshots/$KEY/diff/" "?raw=true"
rm -rf "$WT/$KEY"; mkdir -p "$WT/$KEY"
cp -r "$SHOTS" "$WT/$KEY/shots"; rm -f "$WT/$KEY/shots/"*.log
cp -r "$DIFF" "$WT/$KEY/diff"
cp "$DIFF/summary.md" "$OUTMD"
cd "$WT"; git add -A
if ! git diff --cached --quiet; then
  git commit -qm "screenshots: $KEY @ ${GITHUB_SHA:0:7}"
  for i in 1 2 3 4; do git push -q origin HEAD:ci-screenshots && break
    sleep $((2 ** i)); git fetch -q origin ci-screenshots && git rebase -q FETCH_HEAD || true; done
fi
cd "$ROOT"; git worktree remove --force "$WT"
