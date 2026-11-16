#!/bin/bash
# Keeps the read token for the saving service's private package (yhnocoder/shiyi) in ~/.config/codeboard/shiyi.netrc,
# which SwiftPM is given with --netrc-file, and checks it. The token is read with no echo and goes only into that file
# (mode 600): never into an argument, the environment or any output. Nothing else is written: not ~/.netrc, the
# keychain or git's settings.
set -eu
dir="$HOME/.config/codeboard"
file="$dir/shiyi.netrc"
app=$(cd "$(dirname "$0")/../.." && pwd -P)

if [ -e "$file" ]; then
  printf '%s is there already. Replace it? [y/N] ' "$file" >&2
  read -r answer || answer=""
  case "$answer" in
    y | Y | yes) ;;
    *)
      echo "Kept as it is." >&2
      exit 0
      ;;
  esac
fi

printf 'Your GitHub user name: ' >&2
read -r user || user=""
case "$user" in
  "" | *[!A-Za-z0-9-]*)
    echo "Not a GitHub user name." >&2
    exit 1
    ;;
esac
printf 'Token (read-only, contents of yhnocoder/shiyi; not shown): ' >&2
IFS= read -rs token || token=""
echo >&2
case "$token" in
  "" | *[[:space:]]*)
    echo "No token written: it was empty or had spaces in it." >&2
    exit 1
    ;;
esac

umask 077
mkdir -p "$dir"
tmp=$(mktemp "$dir/.shiyi.netrc.XXXXXX")
# printf is a shell builtin, so the token is in no process's arguments
printf 'machine api.github.com login %s password %s\n' "$user" "$token" > "$tmp"
unset token
chmod 600 "$tmp"
mv -f "$tmp" "$file"
echo "Wrote $file" >&2

# curl reads the file itself; only the status comes back
code=$(curl -s -o /dev/null -w '%{http_code}' --netrc-file "$file" https://api.github.com/repos/yhnocoder/shiyi) || true
case "$code" in
  200) echo "The token can read yhnocoder/shiyi." >&2 ;;
  401 | 403 | 404)
    echo "GitHub answered $code: the token is mistyped, expired, or cannot read yhnocoder/shiyi." >&2
    ;;
  *) echo "GitHub could not be asked (status $code): offline?" >&2 ;;
esac
[ "$code" = 200 ] || exit 1

if ! grep -q 'yhnocoder/shiyi' "$app/Package.swift"; then
  echo "This checkout does not use the package yet: nothing to resolve." >&2
  exit 0
fi
# (resolve.sh: git, which clones the repository, is signed in with the file too, for that run only)
if out=$(SHIYI_NETRC="$file" sh "$app/tools/shiyi/resolve.sh" 2>&1); then
  echo "The Mac app's packages resolved." >&2
else
  echo "Resolving the Mac app's packages failed:" >&2
  printf '%s\n' "$out" | grep -i 'error' | tail -3 >&2
  exit 1
fi
