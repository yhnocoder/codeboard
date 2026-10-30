#!/bin/bash
# For CI: run the board and host perf benchmarks on base and head, alternating (base, head, head, base) so runner drift
# hits both sides equally, then compare them with perfdiff.mjs. Each side runs its own benchmark scripts.
# Usage: tools/review/perf-ab.sh <base checkout dir, or "" for none> <out dir> [quick]
#   quick (PR CI, to fit the 5-minute budget): head, base, head for the board benchmark and one host run per side instead of four and two
#   full (regular runs, no third argument): also the board benchmark with 100 animated GIF stickers on the board (run-perf.mjs --anim),
#   compared on its own in <out dir>/anim and appended to the summary. The base side runs it only when its benchmark has --anim
# Exits 1 when perfdiff.mjs finds a regression.
set -e
BASE=$1; OUT=$2; MODE=$3
mkdir -p "$OUT"
board() { (cd "$1" && node packages/board/test/run-perf.mjs --quick --runs 1 --json "$OUT/board-$2-$3.json") >"$OUT/board-$2-$3.log" 2>&1; }
host() { for i in 1 2; do (cd "$1" && node packages/host/test/run-perf-host.mjs --runs 3) 2>&1 | grep '^{' >>"$OUT/host-$2.log" || true; done; }
# a failed animated run leaves its log and no JSON: perfdiff then reports it, the other results still count
anim() { (cd "$1" && node packages/board/test/run-perf.mjs --quick --anim --runs 1 --json "$OUT/anim/board-$2-$3.json") >"$OUT/anim/board-$2-$3.log" 2>&1 || true; }
HAS_BASE=""
[ -n "$BASE" ] && [ -f "$BASE/packages/board/test/run-perf.mjs" ] && HAS_BASE=1
OUT=$(cd "$OUT" && pwd)
if [ -n "$HAS_BASE" ] && [ "$MODE" = quick ]; then
  board . head 1; board "$BASE" base 1; board . head 2
  host "$BASE" base; host . head
  if ! cmp -s "$BASE/packages/board/test/perf.ts" packages/board/test/perf.ts; then echo "Note: the board benchmark itself changed between base and head." >"$OUT/note.txt"; fi
elif [ -n "$HAS_BASE" ]; then
  board "$BASE" base 1; board . head 1; board . head 2; board "$BASE" base 2
  host "$BASE" base; host . head; host . head; host "$BASE" base
  if ! cmp -s "$BASE/packages/board/test/perf.ts" packages/board/test/perf.ts; then echo "Note: the board benchmark itself changed between base and head." >"$OUT/note.txt"; fi
else
  board . head 1; board . head 2; host . head
fi
if [ "$MODE" != quick ]; then
  mkdir -p "$OUT/anim"
  if [ -n "$HAS_BASE" ] && grep -q -- '"--anim"' "$BASE/packages/board/test/perf.ts"; then
    anim "$BASE" base 1; anim . head 1; anim . head 2; anim "$BASE" base 2
  else
    anim . head 1; anim . head 2
  fi
fi
set +e
node tools/review/perfdiff.mjs "$OUT"; RC=$?
if [ "$MODE" != quick ]; then
  node tools/review/perfdiff.mjs "$OUT/anim" "Performance with 100 animated stickers"; RA=$?
  [ -f "$OUT/anim/summary.md" ] && { echo; cat "$OUT/anim/summary.md"; } >>"$OUT/summary.md"
  [ $RA -ne 0 ] && [ $RC -eq 0 ] && RC=$RA
fi
exit $RC
