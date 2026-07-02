# Vendored: Monocypher 4.0.2

`monocypher.c` and `monocypher.h` are vendored verbatim from Monocypher, used
for the client-side XChaCha20-Poly1305 AEAD (`crypto_aead_lock` / `crypto_aead_unlock`).

- **Version:** 4.0.2 (git tag `4.0.2`, LoupVaillant/Monocypher). The in-file
  version string reads `__git__` because it is substituted from the raw tagged
  source rather than a release tarball; the source is byte-identical to the
  4.0.2 tag (2956 + 321 lines).
- **Source:** https://github.com/LoupVaillant/Monocypher/tree/4.0.2/src
- **License:** dual `BSD-2-Clause OR CC0-1.0` (SPDX header intact in both files).
  GPL-compatible; ag3nt takes it under these terms with headers preserved.
- **SHA-512:**
  - `monocypher.c`: `b4c6389dd3d0ce99922a6d1570b27b59bdd0333046e5c08a802dca126f733bd56d15d8a57f4688206900ee6b15c8f9cf66875d4ba20854ac95544ccb824086c2`
  - `monocypher.h`: `b1572d76efea5bc45d4a7ad9d13eddfcd78beab14b63d6c811ccbfa078fa067b2d81180e6946f33b1e985969998a3f739b7b9ec0961285e70777aa699b124be0`

Only these two files are vendored. `monocypher-ed25519.{c,h}` (HMAC-SHA512/Ed25519)
is deliberately omitted — the AEAD tag does all authentication, so it would be
dead code. Excluded from any C linting.

## Updating

Download `src/monocypher.{c,h}` at the target tag, verify SHA-512, replace the
files, update this record, and re-run `client/test/run.sh` (the KAT must still
match libsodium's output in `protocol/test/crypto.test.ts`).
