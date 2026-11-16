#!/usr/bin/env bash
# seal.sh pack <file> <path>...   archive the paths that exist, compress and encrypt them into <file>
# seal.sh unpack <file> <path>... decrypt <file> and extract it into the current directory
# The passphrase is read from the environment variable SEAL.
set -euo pipefail

if [ $# -lt 3 ] || { [ "$1" != pack ] && [ "$1" != unpack ]; }; then
  echo "usage: seal.sh pack|unpack <file> <path>..." >&2
  exit 1
fi
mode=$1 file=$2
shift 2
if [ -z "${SEAL:-}" ]; then
  echo "seal.sh: SEAL is empty" >&2
  exit 1
fi

# GNU tar in pax format keeps modification times to the nanosecond, which the Swift build compares; the format
# bsdtar writes by default drops them, and a restored build would then compile everything again
if command -v gtar > /dev/null; then
  tar=gtar
elif [ "$(uname)" = Linux ]; then
  tar=tar
else
  echo "seal.sh: GNU tar (gtar) is not on PATH" >&2
  exit 1
fi
cipher=(-aes-256-ctr -pbkdf2 -md sha256 -pass env:SEAL)

if [ "$mode" = pack ]; then
  present=()
  for path in "$@"; do
    if [ -e "$path" ] || [ -L "$path" ]; then present+=("$path"); fi
  done
  if [ ${#present[@]} -eq 0 ]; then
    echo "seal.sh: none of the paths exist: $*" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$file")"
  rm -f "$file"
  # written beside it and renamed when complete, so that a failure leaves no partial file behind
  trap 'rm -f "$file.part"' EXIT
  "$tar" --posix -cf - -- "${present[@]}" | zstd -T0 -q | openssl enc "${cipher[@]}" -salt -out "$file.part"
  mv "$file.part" "$file"
else
  # a file sealed with another passphrase decrypts to bytes that zstd rejects, possibly after tar has written some
  if ! openssl enc -d "${cipher[@]}" -in "$file" | zstd -d -q | "$tar" -x --delay-directory-restore -f -; then
    rm -rf -- "$@"
    echo "seal.sh: $file could not be opened (sealed with another token?)" >&2
    exit 2
  fi
fi
