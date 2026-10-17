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
# E2E_TMP and CDP_PORT let several instances run side by side on one machine
TMP=${E2E_TMP:-/tmp/codeboard-e2e}
export CDP_PORT=${CDP_PORT:-9223}
WS=$TMP/ws
UD=$TMP/user
pkill -f -- "--user-data-dir=$UD" 2>/dev/null || true; sleep 1
rm -rf "$TMP" "$OUT"; mkdir -p "$OUT" "$UD/User"
git clone -q "$REPO/examples/nano-vllm" "$WS"
# E2E_EXTENSIONS="ms-python.python ms-python.vscode-pylance": install into a cache dir first (skipped if already there), then copy into this run's extensions dir
if [ -n "$E2E_EXTENSIONS" ]; then
  CACHE=${E2E_EXT_CACHE:-/tmp/codeboard-ext-cache}
  for e in $E2E_EXTENSIONS; do "$(dirname "$CODE")/bin/code" --install-extension "$e" --extensions-dir "$CACHE" --user-data-dir "$UD" >/dev/null; done
  cp -r "$CACHE" "$UD/ext"
fi
cat > "$UD/User/settings.json" <<JSON
{ "workbench.colorTheme": "$THEME", "workbench.startupEditor": "none", "window.restoreWindows": "none",
  "workbench.tips.enabled": false, "chat.commandCenter.enabled": false, "workbench.secondarySideBar.defaultVisibility": "hidden",
  "editor.minimap.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.ignoreRecommendations": true,
  "files.simpleDialog.enable": true }
JSON
RUN=""; [ -z "$DISPLAY" ] && RUN="xvfb-run -a -s '-screen 0 1700x1100x24'"
eval $RUN "$CODE" "$WS" --extensionDevelopmentPath="$EXT" --user-data-dir="$UD" --extensions-dir="$UD/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-gpu --no-sandbox \
  --remote-debugging-port=$CDP_PORT --window-size=1600,1000 >"$OUT/code.log" 2>&1 &
PID=$!
set +e
node "$HERE/$DRIVER" "$OUT" "$WS" "$UD"
RC=$?
kill $PID 2>/dev/null; pkill -f -- "--user-data-dir=$UD" 2>/dev/null || true
exit $RC
