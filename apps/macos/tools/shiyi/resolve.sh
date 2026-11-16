#!/bin/sh
# Resolves the Mac app's packages with the netrc file that signs in to the saving service's private repository
# (SHIYI_NETRC, else ~/.config/codeboard/shiyi.netrc; fetch.mjs reads the same), for when resolving fails while
# downloading ShiyiFFI or cloning the repository. By hand only: curl and SwiftPM read the file themselves. git, which
# SwiftPM clones the repository with, reads no netrc file SwiftPM is given: for this run only, and for that
# repository only, it asks this script for the file's token (the `credential` branch below, answered over git's own
# pipe), in place of the machine's credential helpers, so nothing is stored anywhere and nothing here prints it
set -u
if [ "${1:-}" = credential ]; then
  [ "${2:-}" = get ] || exit 0
  exec awk '$1 == "machine" && $2 == "api.github.com" {
    for (i = 3; i < NF; i++) if ($i == "password") print "username=x-access-token\npassword=" $(i + 1)
  }' "$SHIYI_NETRC"
fi
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
cd "$(dirname "$0")" || exit 1
export SHIYI_NETRC="$file" SHIYI_RESOLVE="$PWD/resolve.sh"
# an empty helper first drops the machine's own (the Keychain's would keep the token); `.git` since git matches whole
# path parts
n=0
for repo in https://github.com/yhnocoder/shiyi https://github.com/yhnocoder/shiyi.git; do
  for pair in "helper=" 'helper=!sh "$SHIYI_RESOLVE" credential' "useHttpPath=true"; do
    export "GIT_CONFIG_KEY_$n=credential.$repo.${pair%%=*}" "GIT_CONFIG_VALUE_$n=${pair#*=}"
    n=$((n + 1))
  done
done
export GIT_CONFIG_COUNT=$n
cd ../.. && swift package resolve --netrc-file "$file"
