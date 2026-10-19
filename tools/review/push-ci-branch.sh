#!/bin/bash
# For CI: put each <dir> at its <path> on the ci-screenshots branch, keeping everything else there, as the branch's only commit.
# The branch holds no history, so cloning the repo stays small; links into it (blob/ci-screenshots/<path>) keep working as long as
# the path is still there.
# Usage: tools/review/push-ci-branch.sh <commit message> <dir> <path on the branch> [<dir> <path> ...]
# Needs: run from the repo root with a pushable origin. Another job pushing at the same time: fetch again and redo (lease on the tip).
set -e
MSG=$1; shift
IDX=$(mktemp); STAGE=$(mktemp -d); DESTS=()
trap 'rm -rf "$IDX" "$STAGE"' EXIT
while [ $# -gt 0 ]; do mkdir -p "$STAGE/$(dirname "$2")"; cp -r "$1" "$STAGE/$2"; DESTS+=("$2"); shift 2; done
export GIT_AUTHOR_NAME=codeboard-ci GIT_AUTHOR_EMAIL=ci@users.noreply.github.com GIT_COMMITTER_NAME=codeboard-ci GIT_COMMITTER_EMAIL=ci@users.noreply.github.com
for i in 1 2 3 4 5; do
  if git fetch -q --depth 1 origin ci-screenshots 2>/dev/null; then OLD=$(git rev-parse FETCH_HEAD); else OLD=; fi
  rm -f "$IDX"
  if [ -n "$OLD" ]; then GIT_INDEX_FILE=$IDX git read-tree "$OLD"; else GIT_INDEX_FILE=$IDX git read-tree --empty; fi
  GIT_INDEX_FILE=$IDX git rm -rq --cached --ignore-unmatch -- "${DESTS[@]}"
  GIT_INDEX_FILE=$IDX git --work-tree="$STAGE" add -Af -- "${DESTS[@]}"
  TREE=$(GIT_INDEX_FILE=$IDX git write-tree)
  if [ -n "$OLD" ] && [ "$TREE" = "$(git rev-parse "$OLD^{tree}")" ]; then echo "ci-screenshots: ${DESTS[*]} unchanged"; exit 0; fi
  NEW=$(git commit-tree "$TREE" -m "$MSG")
  if git push -q --force-with-lease="ci-screenshots:$OLD" origin "$NEW:refs/heads/ci-screenshots"; then exit 0; fi
  sleep $((2 ** i))
done
echo "ci-screenshots: push failed"; exit 1
