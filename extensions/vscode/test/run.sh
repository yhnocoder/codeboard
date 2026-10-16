#!/bin/bash
# 端到端测试：在真的 VS Code 里装上插件，打开 nano-vllm 的一份拷贝，用 CDP 驱动界面并截图。
# 需要：VS Code（VSCODE_BIN，默认 /opt/vscode/code）、xvfb-run、playwright-core。
# 可选：E2E_EXTENSIONS 指定要一起装的扩展（如 Pylance，让定义预览走真实语言服务）。
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
# E2E_EXTENSIONS="ms-python.python ms-python.vscode-pylance"：先装进缓存目录（装过的跳过），再拷进这次的扩展目录
if [ -n "$E2E_EXTENSIONS" ]; then
  CACHE=${E2E_EXT_CACHE:-/tmp/codeboard-ext-cache}
  for e in $E2E_EXTENSIONS; do "$(dirname "$CODE")/bin/code" --install-extension "$e" --extensions-dir "$CACHE" --user-data-dir "$UD" >/dev/null; done
  cp -r "$CACHE" "$UD/ext"
fi
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
