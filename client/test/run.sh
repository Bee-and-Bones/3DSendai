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
for t in *Test.c; do
  bin="$BUILD/${t%.c}"
  echo "== $t"
  "$CC" -std=c99 -Wall -Wextra -O1 -I vendor/unity -I ../source \
    vendor/unity/unity.c ../source/monocypher.c ../source/crypto.c ../source/discovery.c \
    ../source/term.c ../source/json.c ../source/input.c ../source/quirc.c \
    ../source/paircfg.c ${EXTRA_SRC:-} "$t" -o "$bin" -lm
  "$bin" || fails=$((fails + 1))
done

if [ "$fails" -ne 0 ]; then
  echo "C core tests FAILED ($fails)"
  exit 1
fi

# Warning gate: first-party sources must compile clean under -Werror. Scoped to
# our own code (vendored monocypher/quirc excluded) so a compiler we don't pin
# can't fail CI on code we don't own. Catches e.g. discards-qualifiers from an
# over-eager const. ponytail: first-party only; widen if we ever vendor-audit.
echo "== -Werror first-party gate"
for src in crypto discovery term json input paircfg; do
  "$CC" -std=c99 -Wall -Wextra -Werror -fsyntax-only -I ../source "../source/$src.c"
done

echo "C core tests OK"
