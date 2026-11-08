#!/bin/sh
# Builds CodeBoard.app: the JavaScript bundle (esbuild), the Swift app (release), the bundle folder, an ad-hoc signature with the
# hardened runtime (JavaScriptCore needs the JIT entitlement). `build.sh run [args…]` then launches it.
#   npm run mac          build
#   npm run mac:run      build and launch (arguments after -- go to the app, e.g. -- --open ~/Projects/persona)
set -e
cd "$(dirname "$0")"
APP=build/CodeBoard.app
node build.mjs
swift build -c release
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/CodeBoard "$APP/Contents/MacOS/CodeBoard"
cp dist/bridge.js "$APP/Contents/Resources/bridge.js"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --options runtime --entitlements CodeBoard.entitlements "$APP"
echo "built $APP"
if [ "$1" = "run" ]; then
  shift
  "$APP/Contents/MacOS/CodeBoard" "$@"
fi
