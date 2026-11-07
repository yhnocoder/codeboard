#!/bin/sh
# npm run try [-- folder]: builds this checkout and opens it in a VS Code Extension Development Host, like F5.
# Opens the folder given, else ~/Projects/persona.
set -e
cd "$(git rev-parse --show-toplevel)"
folder=${1:-$HOME/Projects/persona}
case $folder in /*) ;; *) folder=${INIT_CWD:-$PWD}/$folder ;; esac
[ -d "$folder" ] || { echo "try: no folder $folder" >&2; exit 1; }
npm run build
code=code
command -v code >/dev/null || code="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$code" --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$folder"
