#!/bin/bash
# CI 用：把这次 e2e 截图和基线比对，结果推到 ci-screenshots 分支，输出给 PR 描述用的 Markdown。
# 用法：publish-shots.sh <这次截图目录> <存放键，如 pr/12 或 branches/main> <基线键，如 branches/main>
# 需要：GITHUB_REPOSITORY；在仓库根目录、已配置好可推送的 origin 下运行。输出 test-out/shots-summary.md
set -e
SHOTS=$1; KEY=$2; BASE=$3
ROOT=$(pwd); WT=$ROOT/.ci-shots
git config user.name "codeboard-ci"; git config user.email "ci@users.noreply.github.com"
rm -rf "$WT"
if git fetch -q --depth 1 origin ci-screenshots; then git worktree add -q "$WT" FETCH_HEAD
else git worktree add -q --detach "$WT"; (cd "$WT" && git checkout -q --orphan ci-screenshots && git rm -rqf . ); fi
# 先用旧的这次键做基线兜底：PR 第一次跑、base 还没有截图时，至少和自己上一次推送比
B="$WT/$BASE/shots"; [ -d "$B" ] || B="$WT/$KEY/shots"
rm -rf "$ROOT/test-out/shots-diff"
node "$ROOT/tools/review/shotdiff.mjs" "$B" "$SHOTS" "$ROOT/test-out/shots-diff" \
  "https://github.com/$GITHUB_REPOSITORY/blob/ci-screenshots/$KEY/diff/" "?raw=true"
rm -rf "$WT/$KEY"; mkdir -p "$WT/$KEY"
cp -r "$SHOTS" "$WT/$KEY/shots"; rm -f "$WT/$KEY/shots/"*.log
cp -r "$ROOT/test-out/shots-diff" "$WT/$KEY/diff"
cp "$ROOT/test-out/shots-diff/summary.md" "$ROOT/test-out/shots-summary.md"
cd "$WT"; git add -A
if ! git diff --cached --quiet; then
  git commit -qm "screenshots: $KEY @ ${GITHUB_SHA:0:7}"
  for i in 1 2 3 4; do git push -q origin HEAD:ci-screenshots && break
    sleep $((2 ** i)); git fetch -q origin ci-screenshots && git rebase -q FETCH_HEAD || true; done
fi
cd "$ROOT"; git worktree remove --force "$WT"
