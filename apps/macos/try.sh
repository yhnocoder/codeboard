#!/bin/sh
# Opens the sample vault in a build of the app of its own, on a copy outside the repository (SampleVault/README.md):
#   apps/macos/try.sh [folder]
# The copy goes to <folder>, by default "CodeBoard Sample" in the temp folder. A folder that is there already is opened
# as it is, with the changes made in it; delete it to start again. The app is build/CodeBoard Try.app, with the bundle
# id com.example.codeboard.try: its settings and data are its own, never an installed CodeBoard's.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/../.." && pwd -P)
name="CodeBoard Try"
id=com.example.codeboard.try
vault=${1:-"${TMPDIR:-/tmp}/CodeBoard Sample"}

mkdir -p "$(dirname "$vault")"
vault="$(cd "$(dirname "$vault")" && pwd -P)/$(basename "$vault")"
case "$vault/" in
  "$root"/*)
    echo "$vault is inside the repository: give a folder outside it" >&2
    exit 1
    ;;
esac
if [ ! -e "$vault" ]; then
  cp -R "$here/SampleVault" "$vault"
  echo "copied the sample vault to $vault"
fi
if pgrep -f "/$name.app/Contents/MacOS/" > /dev/null; then
  echo "$name is running: quit it first" >&2
  exit 1
fi

if [ ! -d "$root/node_modules" ]; then (cd "$root" && npm ci); fi

log=$(mktemp)
status=0
{ NAME="$name" BUNDLE_ID="$id" FIRST_VAULT="$vault" "$here/make-app.sh" 2>&1 || echo "$?" > "$log.status"; } | tee "$log"
if [ -f "$log.status" ]; then status=$(cat "$log.status"); fi
if [ "$status" != 0 ]; then
  if grep -qi shiyi "$log"; then
    echo "The build needs the private package of the saving service: run apps/macos/tools/shiyi/setup-token.sh first" >&2
  fi
  rm -f "$log" "$log.status"
  exit "$status"
fi
rm -f "$log"

# the build opens FIRST_VAULT only when it has nothing saved from an earlier run, so that is forgotten first
defaults delete "$id" > /dev/null 2>&1 || true
open "$here/build/$name.app"
echo "opened $here/build/$name.app on $vault"
