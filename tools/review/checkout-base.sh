#!/bin/bash
# For CI: check out the base commit next to the head checkout (with the nano-vllm submodule), install and build it.
# Usage: tools/review/checkout-base.sh <base sha> <dir> [--test-drivers]
#   --test-drivers copies head's e2e driver scripts (run.sh, replay.cjs and its helpers wait.cjs / ui.cjs, audit.cjs) into the base checkout,
#   so the same replay runs against the old and the new build.
set -e
SHA=$1; DIR=$2
git worktree add -q --detach "$DIR" "$SHA"
git -C "$DIR" submodule update -q --init examples/nano-vllm
if [ "$3" = --test-drivers ]; then
  mkdir -p "$DIR/tools/review"
  cp extensions/vscode/test/run.sh extensions/vscode/test/replay.cjs extensions/vscode/test/wait.cjs extensions/vscode/test/ui.cjs "$DIR/extensions/vscode/test/"
  cp tools/review/audit.cjs "$DIR/tools/review/"
fi
# --allow-remote=root: a base from before .npmrc had it (npm 12 refuses the tree-sitter-cuda tarball otherwise)
(cd "$DIR" && npm ci --allow-remote=root --no-audit --no-fund && npm run build)
