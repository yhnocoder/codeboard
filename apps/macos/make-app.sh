#!/bin/sh
# Builds the release binary and wraps it into build/CodeBoard.app next to this script.
set -eu
version=0.1.0
cd "$(dirname "$0")"
swift build -c release
bin=$(swift build -c release --show-bin-path)
app=build/CodeBoard.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin/CodeBoard" "$app/Contents/MacOS/CodeBoard"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>CodeBoard</string>
  <key>CFBundleIdentifier</key><string>com.yhnocoder.codeboard</string>
  <key>CFBundleExecutable</key><string>CodeBoard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>27.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# the formula and diagram engines, the board's fonts and backdrops and the SVG page (web/build.mjs): built here and
# carried in the bundle
(cd ../.. && node apps/macos/web/build.mjs)
mkdir -p "$app/Contents/Resources"
cp -R web/dist "$app/Contents/Resources/Assets"
plutil -lint -s "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "built $(pwd)/$app"
