#!/bin/bash
# 端到端测试：在真的 VS Code 里装上插件，打开 nano-vllm 的一份拷贝，用 CDP 驱动界面并截图。
# 需要：VS Code（VSCODE_BIN，默认 /opt/vscode/code）、xvfb-run、playwright-core。
# 用法：npm run e2e    截图和日志在 test-out/<主题>/
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
EXT=$(dirname "$HERE")
REPO=$(cd "$EXT/../.." && pwd)
CODE=${VSCODE_BIN:-${VSCODE_TEST_PATH:-/opt/vscode/code}}
THEME=${THEME:-Default Dark Modern}
TAG=$(echo "$THEME" | tr 'A-Z ' 'a-z-')
OUT=$REPO/test-out/$TAG
WS=/tmp/codeboard-e2e/ws
UD=/tmp/codeboard-e2e/user
pkill -f -- "--user-data-dir=$UD" 2>/dev/null || true; sleep 1
rm -rf /tmp/codeboard-e2e "$OUT"; mkdir -p "$OUT" "$UD/User"
git clone -q "$REPO/examples/nano-vllm" "$WS"
cat > "$UD/User/settings.json" <<JSON
{ "workbench.colorTheme": "$THEME", "workbench.startupEditor": "none", "window.restoreWindows": "none",
  "workbench.tips.enabled": false, "chat.commandCenter.enabled": false, "workbench.secondarySideBar.defaultVisibility": "hidden",
  "editor.minimap.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.ignoreRecommendations": true }
JSON
RUN=""; [ -z "$DISPLAY" ] && RUN="xvfb-run -a -s '-screen 0 1700x1100x24'"
eval $RUN "$CODE" "$WS" --extensionDevelopmentPath="$EXT" --user-data-dir="$UD" --extensions-dir="$UD/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-gpu --no-sandbox \
  --remote-debugging-port=9223 --window-size=1600,1000 >"$OUT/code.log" 2>&1 &
PID=$!
set +e
node "$HERE/drive.cjs" "$OUT" "$WS" "$UD"
RC=$?
kill $PID 2>/dev/null; pkill -f -- "--user-data-dir=$UD" 2>/dev/null || true
exit $RC
