# Vendored: quirc (QR-code recognition library)

`quirc.c` and `quirc.h` are vendored from quirc, used for client-side QR
decoding during fidelity pairing (plan U6, KTD3). `quirc.c` is a single-file
amalgamation of the upstream library; `quirc.h` is the upstream public header
verbatim.

- **Source:** https://github.com/dlbeer/quirc
- **Commit:** `927d680904dc95fdff4cd9d022eb374b438ff8f2` (2025-05-20, tip of master at vendoring)
- **Vendored:** 2026-07-07
- **License:** ISC (Daniel Beer and contributors). Header preserved at the top
  of both files; full text in upstream `LICENSE` at the commit above.
  GPL-compatible; 3dsendai takes it under these terms.
- **SHA-512 (as vendored, i.e. post-amalgamation):**
  - `quirc.c`: `ed9e5293208338b0a6c5ab4a2cd1303adefac29dce3afade6db6fbf2d18c98045182da559d25ff6c0bf875e77b8a8745367bd54279183f08a9952e232a50384d`
  - `quirc.h`: `66d70ac86aa3abba76a9d3112d32b46af196662889586ad1fac5fc4fbdf89fb3649d6d9b687de95c68644674256f8ffac6bb62b5fb237a40311ec148585d5d65`

## What was amalgamated

`quirc.c` concatenates, in this order, the following upstream files (each in a
`/* ==================== lib/... ==================== */` section):

1. `lib/quirc_internal.h` (internal types and the version-db extern)
2. `lib/version_db.c`
3. `lib/quirc.c`
4. `lib/decode.c`
5. `lib/identify.c`

`quirc.h` is `lib/quirc.h` byte-identical. Upstream's demo/test/fuzz tools and
Makefile are not vendored.

## Local modifications

No logic changes. Every in-code edit is marked with a `vendored:` comment.

1. Per-file ISC license headers deduplicated into the single copy at the top
   of `quirc.c` (the text is identical across all five files).
2. `#include "quirc_internal.h"` lines removed (its body is inlined first);
   duplicate system includes left as-is (header guards make them harmless).
3. `area_count()` (from `identify.c`): added `(void)y;` to silence
   `-Wunused-parameter`.
4. `finder_scan()` (from `identify.c`): loop condition cast to
   `x < (unsigned int)q->w` to silence `-Wsign-compare` (`q->w` is
   non-negative by construction in `quirc_resize`).
5. `test_grouping()` (from `identify.c`): `i == (unsigned int)j` cast to
   silence `-Wsign-compare` (`j` iterates `0..num_capstones-1`).

No identifier renames were needed — there are no static-name collisions
across the amalgamated files.

Portability notes: the code needs only libc (`assert.h`, `stdlib.h`,
`string.h`, `limits.h`, `stdbool.h`, `stdint.h`) and `math.h` (doubles), so it
is suitable for devkitARM/armv6k. `QUIRC_FLOAT_TYPE` can be defined to `float`
at build time if double-precision FP is too slow on the 3DS; the default
(double) is unmodified.

## Verification

```
cc -std=c99 -Wall -Wextra -O1 -c client/source/quirc.c -o /dev/null
```

must exit 0 with zero warnings.

## Updating

Clone upstream at the target commit, re-amalgamate in the file order above
(strip per-file license headers and `quirc_internal.h` includes), re-apply the
warning fixes in items 3-5 (or their equivalents if upstream changed), copy
`lib/quirc.h` verbatim, update the commit hash and SHA-512s in this record,
and re-run the compile check plus `client/test/run.sh`.
