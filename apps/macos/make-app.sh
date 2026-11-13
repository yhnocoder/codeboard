#!/bin/sh
# Builds the release binary and wraps it into an .app, ad-hoc signed with the JIT entitlement the formula engines need.
# By default build/CodeBoard.app next to this script, named CodeBoard with the bundle id com.yhnocoder.codeboard.
# Environment variables override these, to build a second app that shares no name, defaults or state with that one:
#   APP_NAME    the app's name and CFBundleName / CFBundleExecutable (default CodeBoard)
#   BUNDLE_ID   CFBundleIdentifier (default com.yhnocoder.codeboard)
#   OUT_DIR     where the .app is written (default build next to this script)
set -eu
version=0.1.0
cd "$(dirname "$0")"
name=${APP_NAME:-CodeBoard}
bundle_id=${BUNDLE_ID:-com.yhnocoder.codeboard}
out_dir=${OUT_DIR:-build}
swift build -c release
bin=$(swift build -c release --show-bin-path)
mkdir -p "$out_dir"
app="$out_dir/$name.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
# the executable target is always CodeBoard; it is renamed to the app's name inside the bundle
cp "$bin/CodeBoard" "$app/Contents/MacOS/$name"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>27.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# the formula and diagram engines, the board's fonts and backdrops and the SVG page (web/build.mjs): built here and
# carried in the bundle, so the app does not depend on the source tree
(cd ../.. && node apps/macos/web/build.mjs)
mkdir -p "$app/Contents/Resources"
cp -R web/dist "$app/Contents/Resources/Assets"
plutil -lint -s "$app/Contents/Info.plist"
# the JIT entitlement JavaScriptCore needs for the formula engines (guideline 5.3)
entitlements=$(mktemp -t codeboard-entitlements).plist
cat > "$entitlements" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
ENT
codesign --force --options runtime --entitlements "$entitlements" --sign - "$app"
rm -f "$entitlements"
echo "built $(cd "$(dirname "$app")" && pwd)/$(basename "$app")"
