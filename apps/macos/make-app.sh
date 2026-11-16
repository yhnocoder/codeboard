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
# Notes are edited in the web page in web/ (the Markdown package's editor) and drawn at rest by the native component
# with the board's fonts (tools/markdown/assets.mjs) and the package's formula engines (its resource bundle): all
# built here and carried in the bundle
(cd ../.. && npm run build -w @yhnocoder/markdown && node apps/macos/web/build.mjs && node apps/macos/tools/markdown/assets.mjs)
mkdir -p "$app/Contents/Resources"
cp -R web/dist "$app/Contents/Resources/NotePage"
cp -R .build-markdown "$app/Contents/Resources/Assets"
cp -R "$bin/better-swift-markdown_MarkdownUI.bundle" "$app/Contents/Resources/"
# the saving service and its page scripts, when tools/shiyi/fetch.mjs has fetched them
if [ -x .build-shiyi/shiyi ]; then cp .build-shiyi/shiyi "$app/Contents/Resources/"; fi
if [ -d .build-shiyi/scripts ]; then cp -R .build-shiyi/scripts "$app/Contents/Resources/ShiyiScripts"; fi
# box, the index service behind Related by Meaning, beside the executable where the app looks for it
if command -v cargo >/dev/null 2>&1; then
  cargo build --release -p box --manifest-path ../../packages/box/Cargo.toml
  cp ../../packages/box/target/release/box "$app/Contents/MacOS/box"
  codesign --force --sign - "$app/Contents/MacOS/box"
else
  echo "cargo not found: built without the box service, so Related by Meaning works only while VS Code's service is running (install Rust: https://rustup.rs)"
fi
plutil -lint -s "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "built $(pwd)/$app"
