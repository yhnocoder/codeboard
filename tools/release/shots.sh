#!/bin/bash
# Release screenshots at 2x: the four feature shots in VS Code light, one board per theme in light and in dark, stacked into one picture each.
# Usage: tools/release/shots.sh [out dir]   (default test-out/release-shots)
# Needs what npm run e2e needs (VS Code, xvfb-run, a build of the extension) plus Chromium for the composition (CHROMIUM or Playwright's).
# Output: 1-overview.png 2-peek.png 3-new-version.png 4-notes.png 5-themes-light.png 6-themes-dark.png
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(mkdir -p "${1:-$REPO/test-out/release-shots}" && cd "${1:-$REPO/test-out/release-shots}" && pwd)
RAW=$OUT/raw
rm -rf "$RAW"; mkdir -p "$RAW"
# The Notes shot's gray completion comes from a local stand-in for the DeepSeek API (no real model or key)
MOCK_PORT=${MOCK_PORT:-17841}
node "$REPO/tools/release/mock-deepseek.mjs" "$MOCK_PORT" & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
# Code stays readable when the board is fitted to the window (the default switches to the outline view below 60%)
export E2E_SCALE=2 DRIVER=release-shots.cjs
# Window chrome kept out of the shots (and Pylance's warnings about nano-vllm's uninstalled imports): no custom title bar (no title, Sign In or layout buttons; Xvfb has no window manager to draw one), no AI / chat items
export E2E_SETTINGS='"codeboard.zoom.overview": 0.3, "codeboard.zoom.map": 0.12, "editor.stickyScroll.enabled": false,
  "window.titleBarStyle": "native", "window.menuBarVisibility": "hidden", "window.commandCenter": false, "workbench.layoutControl.enabled": false,
  "chat.disableAIFeatures": true, "workbench.activityBar.location": "hidden",
  "python.analysis.ignore": ["**"], "problems.decorations.enabled": false,
  "codeboard.ai.provider": "deepseek", "codeboard.ai.deepseekBaseUrl": "http://127.0.0.1:'$MOCK_PORT'"'
THEME="Default Light Modern" SHOTS=features,themes E2E_OUT=$RAW/light bash "$REPO/extensions/vscode/test/run.sh"
THEME="Default Dark Modern" SHOTS=themes E2E_OUT=$RAW/dark bash "$REPO/extensions/vscode/test/run.sh"
rm -f "$OUT"/*.png
cp "$RAW"/light/[1-4]-*.png "$OUT/"
node "$REPO/tools/release/compose-themes.mjs" "$RAW/light/themes" "$OUT/5-themes-light.png" light
node "$REPO/tools/release/compose-themes.mjs" "$RAW/dark/themes" "$OUT/6-themes-dark.png" dark
ls "$OUT"/*.png
