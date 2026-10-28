#!/bin/bash
# End-to-end test: install the extension in a real VS Code, open a copy of nano-vllm, drive the UI over CDP and take screenshots.
# Needs: VS Code (VSCODE_BIN, default /opt/vscode/code), xvfb-run, playwright-core.
# Optional: E2E_EXTENSIONS lists extensions to install alongside (e.g. Pylance, so Definition Peek uses the real language server).
# Usage: npm run e2e    Screenshots and logs go to test-out/<theme>/
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
EXT=$(dirname "$HERE")
REPO=$(cd "$EXT/../.." && pwd)
CODE=${VSCODE_BIN:-${VSCODE_TEST_PATH:-/opt/vscode/code}}
THEME=${THEME:-Default Dark Modern}
TAG=$(echo "$THEME" | tr 'A-Z ' 'a-z-')
DRIVER=${DRIVER:-drive.cjs}   # DRIVER=replay.cjs runs the scripted study-task replay
OUT=${E2E_OUT:-$REPO/test-out/$TAG}
# E2E_SETTINGS adds entries to the user settings (a JSON fragment without braces)
# E2E_TMP and CDP_PORT let several instances run side by side on one machine
TMP=${E2E_TMP:-/tmp/codeboard-e2e}
export CDP_PORT=${CDP_PORT:-9223}
WS=$TMP/ws
UD=$TMP/user
pkill -f -- "--user-data-dir=$UD" 2>/dev/null && sleep 1   # wait only when an earlier run was still there
rm -rf "$TMP" "$OUT"; mkdir -p "$OUT" "$UD/User"
# E2E_WS=<dir> opens a copy of another workspace instead of nano-vllm (for E2E_FLOW flows; drive.cjs's own steps expect nano-vllm):
# a git repository is cloned, so its history is there for version checks; any other folder is copied
SRC=${E2E_WS:-$REPO/examples/nano-vllm}
if [ "$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$SRC" && pwd -P)" ]; then git clone -q "$SRC" "$WS"; else cp -r "$SRC" "$WS"; fi
# E2E_EXTENSIONS="ms-python.python ms-python.vscode-pylance": install into a cache dir first (skipped if already there), then copy into this run's extensions dir
if [ -n "$E2E_EXTENSIONS" ]; then
  CACHE=${E2E_EXT_CACHE:-/tmp/codeboard-ext-cache}
  for e in $E2E_EXTENSIONS; do "$(dirname "$CODE")/bin/code" --install-extension "$e" --extensions-dir "$CACHE" --user-data-dir "$UD" >/dev/null; done
  cp -r "$CACHE" "$UD/ext"
fi
# Pylance's "enable type checking?" prompt pops up after its first workspace-wide analysis (CodeBoard's Go to Implementation warm-up)
# and sits over the board's dock in this narrow window, swallowing the Fit to Window clicks: turn the prompt off
cat > "$UD/User/settings.json" <<JSON
{ "workbench.colorTheme": "$THEME", "workbench.startupEditor": "none", "window.restoreWindows": "none",
  "workbench.tips.enabled": false, "chat.commandCenter.enabled": false, "workbench.secondarySideBar.defaultVisibility": "hidden",
  "editor.minimap.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.ignoreRecommendations": true,
  "files.simpleDialog.enable": true, "python.analysis.enableTypeCheckingRecommendation": false${E2E_SETTINGS:+, $E2E_SETTINGS} }
JSON
# E2E_ARGS adds VS Code command-line flags (e.g. --password-store=basic, so secret storage works without an OS keyring)
# E2E_SCALE=2 renders at 2x device pixels (sharper screenshots, used for release shots); the X screen grows to match
SCALE=${E2E_SCALE:-1}
SCALE_ARG=""; [ "$SCALE" != 1 ] && SCALE_ARG="--force-device-scale-factor=$SCALE"
RUN=""; [ -z "$DISPLAY" ] && RUN="xvfb-run -a -s '-screen 0 $((1700 * SCALE))x$((1100 * SCALE))x24'"
eval $RUN "$CODE" "$WS" --extensionDevelopmentPath="$EXT" --user-data-dir="$UD" --extensions-dir="$UD/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-gpu --no-sandbox \
  --remote-debugging-port=$CDP_PORT --window-size=1600,1000 $SCALE_ARG $E2E_ARGS >"$OUT/code.log" 2>&1 &
PID=$!
set +e
node "$HERE/$DRIVER" "$OUT" "$WS" "$UD" 2>&1 | tee "$OUT/e2e.log"
RC=${PIPESTATUS[0]}
kill $PID 2>/dev/null; pkill -f -- "--user-data-dir=$UD" 2>/dev/null || true
# The extension's output channel (host-side logs) goes with the screenshots, so a failure in CI comes with them: one per window
N=0; for L in $(find "$UD/logs" -name CodeBoard.log 2>/dev/null | sort); do N=$((N + 1)); cp "$L" "$OUT/CodeBoard-$N.log"; done
exit $RC
