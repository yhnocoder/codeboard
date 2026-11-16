#!/bin/sh
# Resolves the Mac app's packages with the netrc file that signs in to the saving service's private repository
# (SHIYI_NETRC, else ~/.config/codeboard/shiyi.netrc; fetch.mjs reads the same), for when resolving fails while
# downloading ShiyiFFI. By hand only: curl and SwiftPM read the file themselves, nothing here prints it
set -u
file=${SHIYI_NETRC:-$HOME/.config/codeboard/shiyi.netrc}
if [ ! -f "$file" ]; then
  echo "$file is missing: make it (mode 600) with the one line" >&2
  echo "  machine api.github.com login <user> password <token>" >&2
  exit 1
fi
case $(stat -f %Lp "$file") in
  ?00) ;;
  *)
    echo "$file can be read by others: chmod 600 $file" >&2
    exit 1
    ;;
esac
cd "$(dirname "$0")/../.." && swift package resolve --netrc-file "$file"
