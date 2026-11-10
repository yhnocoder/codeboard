#!/bin/sh
# Builds the prototype and wraps it into CanvasProto.app next to this script (double-click to open the persona vault).
set -e
cd "$(dirname "$0")"
swift build -c release
# The Note page (web/dist): needs the repository's npm install and the Markdown package's build (packages/markdown/dist).
if [ ! -f ../../packages/markdown/dist/index.js ]; then (cd ../.. && npm run build -w @yhnocoder/markdown); fi
(cd ../.. && node explore/macos-canvas/web/build.mjs)
app=CanvasProto.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp .build/release/CanvasProto "$app/Contents/MacOS/CanvasProto"
mkdir -p "$app/Contents/Resources"
cp -R web/dist "$app/Contents/Resources/web"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>CanvasProto</string>
  <key>CFBundleIdentifier</key><string>dev.codeboard.canvasproto</string>
  <key>CFBundleExecutable</key><string>CanvasProto</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CADisableMinimumFrameDurationOnPhone</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "built $(pwd)/$app"
