#!/bin/bash
# Release screenshots at 2x: the five feature shots in VS Code light, one board per theme in light and in dark, stacked into one picture each.
# Usage: tools/release/shots.sh [out dir]   (default test-out/release-shots)
# Needs what npm run e2e needs (VS Code, xvfb-run, a build of the extension) plus Chromium for the composition (CHROMIUM or Playwright's).
# Output: 1-overview.png 2-expand.png 3-peek.png 4-new-version.png 5-notes.png 6-themes-light.png 7-themes-dark.png
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(mkdir -p "${1:-$REPO/test-out/release-shots}" && cd "${1:-$REPO/test-out/release-shots}" && pwd)
RAW=$OUT/raw
rm -rf "$RAW"; mkdir -p "$RAW"
# Code stays readable when the board is fitted to the window (the default switches to the outline view below 60%)
export E2E_SCALE=2 DRIVER=release-shots.cjs
# Window chrome kept out of the shots: no custom title bar (no title, Sign In or layout buttons; Xvfb has no window manager to draw one), no AI / chat items
export E2E_SETTINGS='"codeboard.zoom.overview": 0.3, "codeboard.zoom.map": 0.12, "editor.stickyScroll.enabled": false,
  "window.titleBarStyle": "native", "window.menuBarVisibility": "hidden", "window.commandCenter": false, "workbench.layoutControl.enabled": false,
  "chat.disableAIFeatures": true, "workbench.activityBar.location": "hidden"'
THEME="Default Light Modern" SHOTS=features,themes E2E_OUT=$RAW/light bash "$REPO/extensions/vscode/test/run.sh"
THEME="Default Dark Modern" SHOTS=themes E2E_OUT=$RAW/dark bash "$REPO/extensions/vscode/test/run.sh"
cp "$RAW"/light/[1-5]-*.png "$OUT/"
node "$REPO/tools/release/compose-themes.mjs" "$RAW/light/themes" "$OUT/6-themes-light.png" light
node "$REPO/tools/release/compose-themes.mjs" "$RAW/dark/themes" "$OUT/7-themes-dark.png" dark
ls "$OUT"/*.png
