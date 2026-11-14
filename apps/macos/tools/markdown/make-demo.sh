#!/bin/sh
# Packages MarkdownDemo, the window to try the Markdown component in, as an app: the release binary, the component's
# fonts and engines (assets.mjs) in Contents/Resources/Assets, ad-hoc signed with the JIT entitlement the formula
# engines need. It shares no name, defaults or caches with the CodeBoard app.
#   OUT_DIR  where "Markdown Demo.app" is written (default apps/macos/build)
set -eu
cd "$(dirname "$0")/../.."
out_dir=${OUT_DIR:-build}
name="Markdown Demo"
swift build -c release --product MarkdownDemo
bin=$(swift build -c release --show-bin-path)
(cd ../.. && node apps/macos/tools/markdown/assets.mjs)
mkdir -p "$out_dir"
app="$out_dir/$name.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/MarkdownDemo" "$app/Contents/MacOS/MarkdownDemo"
cp -R .build-markdown "$app/Contents/Resources/Assets"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>com.yhnocoder.codeboard.markdown-demo</string>
  <key>CFBundleExecutable</key><string>MarkdownDemo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>27.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSItemContentTypes</key><array><string>net.daringfireball.markdown</string><string>public.plain-text</string></array>
  </dict></array>
</dict></plist>
PLIST
plutil -lint -s "$app/Contents/Info.plist"
entitlements=$(mktemp -t markdown-demo-entitlements).plist
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
