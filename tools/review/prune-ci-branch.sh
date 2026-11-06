#!/bin/bash
# For CI: remove from the ci-screenshots branch the folders no run writes any more, so cloning the repo stays small:
# pr/<N> of each pull request closed more than KEEP_DAYS days ago (default 7), and the old nightly/ folder (now regular/).
# Links to a removed folder from old PR descriptions stop working.
# Usage: tools/review/prune-ci-branch.sh [--dry]
# Needs: GH_TOKEN and GITHUB_REPOSITORY; run from the repo root with a pushable origin.
set -e
KEEP_DAYS=${KEEP_DAYS:-7}
git fetch -q --depth 1 origin ci-screenshots || { echo "ci-screenshots: no branch"; exit 0; }
CUT=$(date -u -d "$KEEP_DAYS days ago" +%Y-%m-%dT%H:%M:%SZ)
# Every pull request closed (merged or not) before the cut-off; ISO times in UTC compare as strings
OLD=$(gh api "repos/$GITHUB_REPOSITORY/pulls?state=closed&per_page=100" --paginate \
  --jq ".[] | select(.closed_at < \"$CUT\") | .number")
GONE=()
for n in $(git ls-tree --name-only FETCH_HEAD pr/ | sed 's#^pr/##'); do
  grep -qx "$n" <<<"$OLD" && GONE+=("pr/$n")
done
git cat-file -e FETCH_HEAD:nightly 2>/dev/null && GONE+=(nightly)
[ ${#GONE[@]} -eq 0 ] && { echo "ci-screenshots: nothing to prune"; exit 0; }
echo "ci-screenshots: pruning ${GONE[*]}"
[ "$1" = --dry ] && exit 0
ARGS=(); for p in "${GONE[@]}"; do ARGS+=(- "$p"); done
tools/review/push-ci-branch.sh "prune ${#GONE[@]} old folders (PRs closed over $KEEP_DAYS days ago)" "${ARGS[@]}"
