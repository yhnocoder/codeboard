#!/bin/sh
# Builds the release binary and wraps it into build/CodeBoard.app next to this script.
# A build to try beside the app in use, sharing nothing with it (its defaults and Keychain items follow its bundle
# identifier): NAME="CodeBoard Step 2" BUNDLE_ID=com.example.codeboard.step2 FIRST_VAULT=<folder> ./make-app.sh
# makes build/<NAME>.app, which opens FIRST_VAULT on its first launch.
set -eu
version=0.1.0
name=${NAME:-CodeBoard}
bundle_id=${BUNDLE_ID:-com.yhnocoder.codeboard}
first_vault=${FIRST_VAULT:-}
cd "$(dirname "$0")"
swift build -c release
bin=$(swift build -c release --show-bin-path)
app="build/$name.app"
first=""
if [ -n "$first_vault" ]; then first="<key>CodeBoardFirstVault</key><string>$first_vault</string>"; fi
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin/CodeBoard" "$app/Contents/MacOS/CodeBoard"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>$first
  <key>CFBundleExecutable</key><string>CodeBoard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>27.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# Notes are drawn by the web page in web/ (the Markdown package's editor): built here and carried in the bundle
(cd ../.. && npm run build -w @yhnocoder/markdown && node apps/macos/web/build.mjs)
mkdir -p "$app/Contents/Resources"
cp -R web/dist "$app/Contents/Resources/NotePage"
plutil -lint -s "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "built $(pwd)/$app"
