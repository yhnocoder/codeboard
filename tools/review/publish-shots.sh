#!/bin/bash
# For CI: diff this e2e run's screenshots against the baseline, push the result to the ci-screenshots branch, and write Markdown for the PR description.
# Usage: publish-shots.sh <this run's screenshot dir> <storage key, e.g. pr/12 or branches/main> <baseline: a local dir, or keys such as "pr/11 branches/main", the first one stored wins> [summary.md path]
# Needs: GITHUB_REPOSITORY; run from the repo root with a pushable origin. Writes the summary to test-out/shots-summary.md unless a path is given
set -e
SHOTS=$1; KEY=$2; BASE=$3
ROOT=$(pwd); WT=$ROOT/.ci-shots; OUTMD=${4:-$ROOT/test-out/shots-summary.md}; DIFF=$ROOT/test-out/shots-diff-${KEY//\//-}
rm -rf "$WT"
if git fetch -q --depth 1 origin ci-screenshots; then git worktree add -q "$WT" FETCH_HEAD
else git worktree add -q --detach "$WT"; (cd "$WT" && git checkout -q --orphan ci-screenshots && git rm -rqf . ); fi
# A local dir as baseline: screenshots of the base commit taken in this same CI run. Keys: the first one with stored shots,
# then this key's own last push, so a run never compares against nothing while anything is stored
if [ -d "$BASE" ]; then B=$BASE; else for k in $BASE $KEY; do B="$WT/$k/shots"; [ -d "$B" ] && break; done; fi
rm -rf "$DIFF"
node "$ROOT/tools/review/shotdiff.mjs" "$B" "$SHOTS" "$DIFF" \
  "https://github.com/$GITHUB_REPOSITORY/blob/ci-screenshots/$KEY/diff/" "?raw=true"
# Only shots/ and diff/ are this run's: other runs keep their own folders under the key (pr/12/replay)
rm -rf "$ROOT/test-out/shots-new"; cp -r "$SHOTS" "$ROOT/test-out/shots-new"; rm -f "$ROOT/test-out/shots-new/"*.log
cp "$DIFF/summary.md" "$OUTMD"
"$ROOT/tools/review/push-ci-branch.sh" "screenshots: $KEY @ ${GITHUB_SHA:0:7}" "$ROOT/test-out/shots-new" "$KEY/shots" "$DIFF" "$KEY/diff"
rm -rf "$ROOT/test-out/shots-new"
git worktree remove --force "$WT"
