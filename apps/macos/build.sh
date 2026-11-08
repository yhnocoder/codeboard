#!/bin/sh
# Builds CodeBoard.app: the JavaScript bundle (esbuild), the card page (Vite, dist/web), the Swift app (release), the bundle folder, an ad-hoc signature with the
# hardened runtime (JavaScriptCore needs the JIT entitlement). `build.sh run [args…]` then launches it.
#   npm run mac          build
#   npm run mac:run      build and launch (arguments after -- go to the app, e.g. -- --open ~/Projects/persona)
set -e
cd "$(dirname "$0")"
APP=build/CodeBoard.app
[ -d ../../packages/markdown/dist ] || (cd ../.. && npm run build -w @yhnocoder/markdown)
node build.mjs
# box, the index service ⌘K shares with VS Code: the binary the box build makes for this Mac
BOX=../../packages/box/bin/darwin-$(uname -m | sed 's/x86_64/x64/')/box
[ -x "$BOX" ] || node ../../packages/box/build.mjs
npx vite build -c web/vite.config.ts --logLevel warn
swift build -c release
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/CodeBoard "$APP/Contents/MacOS/CodeBoard"
cp dist/bridge.js dist/router.js dist/themes.json dist/icons.json dist/*.wasm dist/seal-*.png dist/ink-*.svg "$APP/Contents/Resources/"
cp -R dist/fonts "$APP/Contents/Resources/fonts"
cp -R dist/web "$APP/Contents/Resources/web"
cp "$BOX" "$APP/Contents/MacOS/box"
codesign --force --sign - --options runtime "$APP/Contents/MacOS/box"
cp Info.plist "$APP/Contents/Info.plist"
# the icon, from CodeBoard's glyph (icon.swift): the 1024 px master, its sizes (sips) and the .icns (iconutil)
SET=.build/AppIcon.iconset
rm -rf "$SET" && mkdir -p "$SET"
swift icon.swift ../../extensions/vscode/media/icon.svg .build/icon-1024.png
for s in 16 32 128 256 512; do
  sips -z $s $s .build/icon-1024.png --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) .build/icon-1024.png --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - --options runtime --entitlements CodeBoard.entitlements "$APP"
echo "built $APP"
if [ "$1" = "run" ]; then
  shift
  "$APP/Contents/MacOS/CodeBoard" "$@"
fi
