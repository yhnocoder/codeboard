#!/bin/sh
# The example repositories the tests run on (git submodules). npm run examples [-- sglang DeepEP]; default nano-vllm.
# In a linked git worktree whose main checkout already has the submodule, it is checked out from that clone: nothing is fetched,
# so it also works where GitHub cannot be reached. sglang and DeepEP are fetched shallow (only for trying things by hand).
set -e
cd "$(git rev-parse --show-toplevel)"
COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
[ $# -eq 0 ] && set -- nano-vllm
for n in "$@"; do
  p=examples/$n
  if [ "$COMMON" != "$(git rev-parse --path-format=absolute --git-dir)" ] && [ -d "$COMMON/modules/$p" ]; then
    git submodule init -q "$p"
    git config "submodule.$p.url" "$COMMON/modules/$p"
    git -c protocol.file.allow=always submodule update -q "$p"
  elif [ "$n" = nano-vllm ]; then
    git submodule update --init "$p"
  else
    git submodule update --init --depth 1 "$p"
  fi
done
