#!/bin/sh
# Host-compile and run the client's pure-C core tests (no devkitPro needed).
# This is the cross-library KAT gate: Monocypher (here) must reproduce the
# byte-exact vectors that libsodium produces in protocol/test/*.test.ts.
set -eu

cd "$(dirname "$0")"
CC="${CC:-cc}"
BUILD=build
mkdir -p "$BUILD"

fails=0
for t in *_test.c; do
  bin="$BUILD/${t%.c}"
  echo "== $t"
  "$CC" -std=c99 -Wall -Wextra -O1 -I vendor/unity -I ../source \
    vendor/unity/unity.c ../source/monocypher.c ../source/crypto.c \
    ${EXTRA_SRC:-} "$t" -o "$bin"
  "$bin" || fails=$((fails + 1))
done

if [ "$fails" -ne 0 ]; then
  echo "C core tests FAILED ($fails)"
  exit 1
fi
echo "C core tests OK"
