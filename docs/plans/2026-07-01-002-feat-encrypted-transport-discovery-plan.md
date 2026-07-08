---
date: 2026-07-01
status: active
origin: (removed in docs cleanup; original requirements in git history)
---

# feat: Encrypted Transport + Zero-Config Discovery (3Base merge)

> Merge the two strong pieces of the sibling repo **3Base** into 3dsendai: an XChaCha20-Poly1305 AEAD transport and zero-config UDP discovery. 3dsendai keeps its agent-orchestration host, adapters, registry, and C client as the foundation; 3Base contributes the secure pipe and the "no hardcoded IP" pairing. This closes **R20b** (encryption when remote) and **R21** (no hardcoded keys/ports), advancing milestone **M4**.

## Summary

Today 3dsendai speaks plaintext length-prefixed TCP frames (`[u32 len][u8 type][u32 sid][json]`) with a plaintext token gate. The host **listens** (`Bun.listen`, port 4791); the 3DS **connects**. 3Base proved the reverse topology with a clean AEAD frame and UDP auto-discovery. This plan ports 3Base's crypto and discovery **designs** (not its GPL-derived scaffolding) into 3dsendai, keeping 3dsendai's connection direction and its whole app layer (ATTACH, reconnect replay, capability negotiation, macropad) intact.

Encryption wraps at the **frame level**: each existing AgentBus frame becomes the plaintext of one AEAD record, keyed by a 32-byte PSK. Discovery adds a UDP probe/reply so the 3DS finds the host without `SERVER_HOST`. Both are **PSK-gated and opt-in by config** — when `SENDAI_PSK` is set on both ends, frames are encrypted and the PSK is the authenticator; when unset (loopback dev, existing tests), behavior is unchanged. This preserves the current 139-test suite while adding the secure path.

---

## Problem Frame

Two gaps block M4 (remote + secure), both already tracked as thin units in the M1 plan (U19 encryption 🟡, R21):

1. **No transport encryption.** The host executes agent tool calls. Once it's reachable off-loopback, cleartext frames let any on-path party read prompts/output and — worse — the token itself. R20b requires encryption when non-local; the M1 plan's S2 spike contemplated mbedTLS-vs-tunnel and is now **superseded** by the XChaCha20/Monocypher decision.
2. **Hardcoded host IP.** The client hardcodes `SERVER_HOST` in `config.h` and must be recompiled to move hosts. R21 forbids relying on hardcoded ports/keys; zero-config discovery removes the IP.

3Base already solved both with a reviewed design (XChaCha20-Poly1305 AEAD, per-direction seq counters in AAD, UDP challenge/reply discovery). We reimplement that design in 3dsendai from its `PROTOCOL.md` spec and known-answer test (KAT) vectors — which are facts, not copyrightable expression — so no GPL-3.0 scaffolding is pulled in. See **Licensing** decision below.

---

## Key Technical Decisions

- **KTD1 — Frame-level AEAD, not connection-level.** Each plaintext AgentBus frame (`[u32 len][u8 type][u32 sid][json]`) is sealed as one record: `nonce(24) ‖ ciphertext(N) ‖ mac(16)`, carried under an outer `[u32 len]` prefix. AEAD needs message boundaries anyway, so connection-level degenerates to this with more work. The host seam is the single `ByteSink` in `host/src/server/connection.ts` (encrypt on write) plus a decrypt step before `conn.feed()`; the client seam is inside `ab_net_send`/`ab_net_poll` in `client/source/net.c`. The public `ab_net_*` API and `main.c` stay unchanged.

- **KTD2 — PSK-gated, opt-in encryption preserves the plaintext path.** A host with `SENDAI_PSK` set requires every connection to decrypt; without it, plaintext + token as today. This keeps all existing tests green and satisfies R20b (encrypt when remote) without forcing crypto onto the loopback dev loop. The PSK is the transport authenticator when active; 3dsendai's ATTACH token remains the app-layer session handshake (it carries the reconnect cursor and session binding) but is no longer the security boundary under a PSK.

- **KTD3 — libsodium on host, Monocypher on client, reconciled in the wrappers.** Host uses `libsodium-wrappers` (`crypto_aead_xchacha20poly1305_ietf_*`); client vendors **Monocypher 4.0.2** (`crypto_aead_lock`/`unlock`). libsodium appends the MAC to the ciphertext; Monocypher emits it separately. The split/join is confined to the seal/open wrappers so the wire bytes are identical. Two independent RFC-conformant impls that agree (guarded by a shared KAT) reduce single-implementation-bug risk. `libsodium-wrappers` is 3dsendai's first host runtime dependency — acceptable; it is the same version 3Base runs on the same Bun (1.3.14).

- **KTD4 — AAD binds context, direction, epoch, and sequence.** AAD (authenticated, not transmitted) = `"3dsendai-msg-v1"(12) ‖ dir(1) ‖ epoch(8) ‖ seq(8 BE)`.
  - `dir`: `0x00` = host→3DS, `0x01` = 3DS→host — blocks reflection.
  - `seq`: per-direction monotonic counter, resets to 0 per TCP connection. The receiver decrypts against its **own** expected counter; a replayed/reordered/spliced frame fails the tag. No seq is ever read off the wire.
  - `epoch`: 8-byte random value the host mints per connection and sends as the first cleartext bytes after accept; both ends bind it into AAD. This defeats **cross-session replay** — a frame captured from an old session won't validate under a fresh epoch. 3Base lacked this and its own PROTOCOL.md flagged it as required before commands carry real authority; 3dsendai's host executes actions, so it's in scope now. Epoch `0` is the "not negotiated" value used by the plaintext/test path.
  - Distinct context string `"3dsendai-msg-v1"` (vs 3Base's) intentionally breaks wire-compat and provides **domain separation** from discovery datagrams, which use `"3dsendai-dsc-v1"`. 3Base reused one context across both, letting a captured probe splice into a TCP stream; we fix that here.

- **KTD5 — Discovery roles flip; dir semantics do not.** 3dsendai's host listens on TCP, so it also **replies** to discovery: the **3DS broadcasts** the probe (`255.255.255.255:41337`), the host replies unicast with `challenge(8) ‖ hostTcpPort(2 BE)`. Datagram = `MAGIC "ag3n"(4) ‖ TYPE(1) ‖ sealed-frame`, sealed under the discovery AAD context, seq 0. The `dir` byte still encodes travel direction, unchanged. The client hands the discovered dotted-quad + port straight into the existing `ab_net_connect`, so `inet_addr`-only addressing needs no change. `SERVER_HOST` becomes a fallback used only when discovery times out.

- **KTD6 — Single-source the crypto/discovery constants through the existing codegen.** `KEY_BYTES`, `NONCE_BYTES`, `MAC_BYTES`, both AAD context strings, discovery magic, and default ports are added to `protocol/codegen/message-types.source.ts` and emitted into both a generated TS constants module and `client/source/protocol.h`. New wire constants go through codegen, never hand-added to the C header — mirroring the message-type discipline and guarded by `protocol/test/codegen.test.ts`.

- **KTD7 — Reimplement from spec + KAT to keep 3dsendai's license clean.** Monocypher (BSD-2 OR CC0) is vendored verbatim with headers intact. Everything else is reimplemented from 3Base's `PROTOCOL.md` and its KAT hex vectors — not copied — because 3Base's build/CI/packaging scaffolding is adapted from 3Drop (third-party GPL-3.0). The protocol design and test vectors are facts. Result: 3dsendai does not inherit GPL-3.0.

- **KTD8 — Bounded frame length on the listener.** The host is the exposed listener; `readFrames`/the secure decoder must reject `len == 0 || len > MAX_SECURE_FRAME` **before** buffering, closing the connection. 3Base's PC side buffered an unbounded attacker-declared length pre-auth; we cap it. The C client already caps at its `RXBUF`.

---

## High-Level Technical Design

Encrypted frame on the wire (one AEAD record under the existing outer length prefix):

```
[u32 outer_len BE] [ nonce(24) | ciphertext(N) | mac(16) ]
                         |            |
   plaintext of the record = existing AgentBus frame:
   [u32 len BE][u8 type][u32 session_id BE][canonical-json payload]

   AAD (authenticated, not sent) = "3dsendai-msg-v1"(12) | dir(1) | epoch(8 BE) | seq(8 BE)
```

Connection lifecycle (host listens, 3DS connects, PSK active):

```
 3DS                                   Host
  |  --- UDP probe (broadcast) ------>  |  udp responder verifies PSK, matches challenge
  |  <-- UDP reply (unicast) ---------  |  payload = challenge ‖ hostTcpPort
  |                                     |
  |  === TCP connect (discovered) ===>  |  accept
  |  <-- epoch(8) cleartext ----------  |  mint per-connection epoch
  |  --- sealed ATTACH (seq0,dir1) -->  |  decrypt w/ PSK+epoch; fail => close
  |  <-- sealed HELLO (seq0,dir0) ----  |  PSK proves auth; token now belt-and-suspenders
  |  === encrypted AgentBus frames ===  |  prompt / stream / approve, seq++ each dir
```

Loopback dev / existing tests (no PSK): epoch=0, plaintext frames, token gate — byte-identical to today.

## Output Structure

New and vendored files (repo-relative):

```
protocol/src/
  secure-frame.ts          # AAD build, sealFrame/openFrame, SecureFrameDecoder, length cap
  crypto.ts                # libsodium seal/open wrapper (host+protocol shared)
  crypto-constants.generated.ts   # emitted by codegen (KEY/NONCE/MAC/contexts/ports)
protocol/test/
  crypto.test.ts           # AEAD KAT (libsodium reproduces the fixed vector)
  secure-frame.test.ts     # seal/open round-trip, tamper/seq/dir/epoch rejection, length cap
  secure-golden.test.ts    # byte-exact encrypted + discovery vectors
  golden/secure-vectors.json
host/src/server/
  discovery.ts             # UDP responder (Bun udpSocket): verify probe, reply w/ tcp port
host/src/
  psk.ts                   # SENDAI_PSK hex load/validate, keyFromHex/keyToHex
host/test/
  discovery.test.ts, secure-transport.test.ts
client/source/
  monocypher.c, monocypher.h      # vendored 4.0.2 (BSD-2 OR CC0)
  crypto.c/.h              # oshSeal/oshOpen wrappers + AAD + seal/open frame
  discovery.c/.h           # build probe, parse reply (3DS = prober here)
  MONOCYPHER-VENDOR.md
client/test/                # host-compilable C core KAT (unity), run in CI without devkitPro
  crypto_test.c, frame_test.c, discovery_test.c, vendor/unity/...
.github/workflows/
  check.yml                # host bun check + C KAT + devkitPro docker build
```

---

## Implementation Units

### U23. Crypto primitives + vendored Monocypher + single-sourced constants

**Goal:** Establish the AEAD building blocks on both sides and the shared constants, with a cross-library KAT proving libsodium and Monocypher agree byte-for-byte.
**Requirements:** R20b, R21, R2 (client/agent-agnostic wire).
**Dependencies:** none.
**Files:** `protocol/src/crypto.ts`, `protocol/codegen/message-types.source.ts` (extend), `protocol/codegen/generate.ts` (emit constants), `protocol/src/crypto-constants.generated.ts` (generated), `client/source/protocol.h` (generated additions), `client/source/monocypher.c`, `client/source/monocypher.h`, `client/source/crypto.c`, `client/source/crypto.h`, `client/source/MONOCYPHER-VENDOR.md`, `protocol/test/crypto.test.ts`, `client/test/crypto_test.c`, `protocol/test/codegen.test.ts` (extend).
**Approach:**
- Vendor Monocypher 4.0.2 `monocypher.{c,h}` verbatim from the official tarball; record SHA-512 + provenance + `SPDX-License-Identifier: BSD-2-Clause OR CC0-1.0` in `MONOCYPHER-VENDOR.md`. The Makefile globs `source/*.c`, so no Makefile edit — but confirm the build immediately (see Execution note).
- `protocol/src/crypto.ts`: `cryptoReady(): Promise<void>` (await `sodium.ready` once), `encrypt(key,nonce,aad,plain)`, `decrypt(key,nonce,aad,sealed): Uint8Array|null` (catch libsodium throw → null). Add `libsodium-wrappers` to `host/package.json` deps and `@types/libsodium-wrappers` dev-dep.
- `client/source/crypto.c`: `ab_seal(key,nonce,aad,aadLen,plain,plainLen,cipher,mac)` → `crypto_aead_lock`; `ab_open(...)` → `crypto_aead_unlock` (0/-1). MAC written to its own wire slot (Monocypher-native).
- Extend the codegen single-source with `KEY_BYTES=32`, `NONCE_BYTES=24`, `MAC_BYTES=16`, `AAD_MSG_CONTEXT="3dsendai-msg-v1"`, `AAD_DSC_CONTEXT="3dsendai-dsc-v1"`, `DISCOVERY_MAGIC="ag3n"`, `DEFAULT_DISCOVERY_PORT=41337`, `DEFAULT_TCP_PORT` (=4791, 3dsendai's existing). Emit into the generated TS constants module and `protocol.h`. `codegen.test.ts` regenerates in-memory and fails on drift.
- Type all byte-buffer fields explicitly as `Uint8Array` (per the Bun typed-array variance learning).
**Patterns to follow:** `protocol/codegen/generate.ts` two-target emit; 3Base wrapper shape (mac split/join in wrapper only); `docs/solutions/build-errors/devkitpro-3ds-homebrew-cross-compile.md`.
**Test scenarios:**
- AEAD KAT: fixed key `00..1f`, nonce `40..57`, aad `"3dsendai-kat"`, plaintext `"3dsendai KAT v1"` → assert exact sealed hex in **both** `crypto.test.ts` (libsodium) and `crypto_test.c` (Monocypher). Regenerate the constant once from libsodium.
- Round-trip encrypt→decrypt returns original (both sides).
- Tampered MAC → `decrypt` returns null (TS) / `ab_open` returns -1 (C).
- Wrong key → rejected (both).
- Wrong-size key/nonce → throws (TS) / guarded (C).
- `codegen.test.ts`: generated TS constants and `protocol.h` match a fresh render.
**Execution note:** Build the client in the real toolchain the moment Monocypher lands — `docker run --rm -v "$PWD/client":/work -w /work devkitpro/devkitarm:latest make` — before writing higher layers. Keep `LD := $(CC)` and ARCH flags exactly `-march=armv6k -mtune=mpcore -mfloat-abi=hard`.
**Verification:** `bun test protocol/test/crypto.test.ts` green; `cc`-host-compiled `crypto_test.c` passes; devkitARM `make` produces a `.3dsx` with Monocypher linked.

### U24. Secure frame codec (protocol/) with AAD, epoch, seq, length cap + golden vectors

**Goal:** A pure, tested codec that seals/opens an existing AgentBus frame as one AEAD record, plus a streaming decoder with a hard length cap. Mirror the byte layout in a C helper.
**Requirements:** R1, R3, R20b, KTD1, KTD4, KTD8.
**Dependencies:** U23.
**Files:** `protocol/src/secure-frame.ts`, `protocol/src/index.ts` (re-export), `client/source/crypto.c`/`.h` (frame seal/open + AAD), `protocol/test/secure-frame.test.ts`, `protocol/test/secure-golden.test.ts`, `protocol/test/golden/secure-vectors.json`, `protocol/test/generate-golden.ts` (extend), `client/test/frame_test.c`.
**Approach:**
- `buildAad(context, dir, epoch: bigint, seq: bigint): Uint8Array` — `DataView.setBigUint64(..., false)` big-endian for epoch and seq. C mirror builds it bytewise (endianness-immune).
- `sealFrame(key, dir, epoch, seq, plaintextFrameBytes, nonce?)` → `nonce ‖ ct ‖ mac`; `openFrame(key, dir, epoch, seq, record): Uint8Array|null`. The `plaintext` here is a full encoded AgentBus frame from `encodeFrame` — the secure layer is agnostic to message types.
- `SecureFrameDecoder`: buffers the outer `[u32 len]` records, enforces `len==0 || len>MAX_SECURE_FRAME` → throw (caller closes), emits sealed records for the transport to open against its counter. Explicit `Uint8Array` field types.
- C side (`crypto.c`): `ab_seal_frame`/`ab_open_frame` writing nonce/ct/mac contiguously into a caller buffer; `MAX_PLAIN` sized to comfortably hold an AgentBus frame (client `RXBUF` is 16 KiB — keep records well under it; document the bound).
**Patterns to follow:** `protocol/src/frames.ts` (`FrameDecoder` streaming, `toHex`/`fromHex`); `protocol/test/generate-golden.ts` → `vectors.json` → `golden.test.ts` two-direction assertion.
**Test scenarios:**
- Seal→open round-trip returns the exact input frame bytes.
- Replay/reorder: opening a record against the wrong `seq` → null.
- Reflection: wrong `dir` → null.
- Cross-session: wrong `epoch` → null.
- Tamper any byte of nonce/ct/mac → null.
- `SecureFrameDecoder`: single record; two records coalesced in one chunk; a partial record split across chunks (remainder retained); `len==0` and `len>MAX` both throw.
- Golden `secure-vectors.json`: fixed key/nonce/epoch/seq encrypted vector for a representative frame (e.g. ATTACH) asserted byte-exact encode **and** decode; C `frame_test.c` asserts the same hex.
**Verification:** `bun test protocol/` green including new suites; `frame_test.c` KAT matches the TS-produced hex.

### U25. Host encrypted transport: PSK config, encrypting sink, epoch handshake, counters

**Goal:** Wire the secure codec into the host server so a PSK-configured host negotiates an epoch, encrypts every frame, and rejects anything that fails to decrypt — with the plaintext path untouched when no PSK is set.
**Requirements:** R4, R5, R20a, R20b, R21, KTD2, KTD4, KTD8.
**Dependencies:** U24.
**Files:** `host/src/psk.ts`, `host/src/server/index.ts`, `host/src/server/connection.ts`, `host/bin/host.ts` (env `SENDAI_PSK`), `host/src/server/auth.ts` (note token now secondary under PSK), `host/test/secure-transport.test.ts`, `host/test/connection.test.ts` (extend), `host/test/e2e.test.ts` (encrypted MockDevice path).
**Approach:**
- `host/src/psk.ts`: load/validate `SENDAI_PSK` (64 hex → 32 bytes), `keyFromHex`/`keyToHex`. If set, `assertBindAllowed` may bind non-loopback (PSK satisfies the "not open on the network" guard alongside the token).
- In `server/index.ts` `open`: if PSK active, create a per-connection transport in `ConnState` holding `{ key, epoch, sendSeq, recvSeq }`, mint an 8-byte epoch (`crypto.getRandomValues`), write it cleartext as the first bytes, and pass an **encrypting `ByteSink`** to `Connection` (seal each outbound frame, `sendSeq++`). In `data`: buffer via `SecureFrameDecoder`, `openFrame` each record against `recvSeq` (++), route the recovered plaintext into `conn.feed`; a null open → close the socket (drop, no cleartext error frame leaked). When PSK inactive, behavior is exactly as today.
- Per-connection counters/epoch reset naturally because each TCP connection makes a fresh `ConnState` — orthogonal to durable-session replay (that's app-layer via the ATTACH cursor, AE1 still holds).
**Patterns to follow:** `Connection`'s single `ByteSink` seam; `host/test/connection.test.ts` `PausableSink`; `host/test/e2e.test.ts` `MockDevice` (add a crypto-speaking variant).
**Test scenarios:**
- PSK set: MockDevice performing epoch-receive + sealed ATTACH gets a sealed HELLO; full prompt→output_chunk loop works encrypted.
- Wrong PSK on the device → host closes on the first frame; no plaintext leaked.
- Replayed record (reused seq) → close.
- Frame with `len>MAX` → close before buffering.
- No PSK: existing `connection.test.ts`/`server.test.ts`/`e2e.test.ts` pass unchanged (regression gate).
- AE1 preserved: encrypted session, reconnect makes a new TCP connection (new epoch/counters), ATTACH-with-cursor replays missed frames.
**Execution note:** Add the encrypted MockDevice path as a failing test first, then wire the sink.
**Verification:** full `bun test` green (existing + new); `tsc --noEmit` clean.

### U26. Client encrypted transport: key load, seal/open in net.c, epoch receive

**Goal:** The 3DS client encrypts/decrypts frames transparently inside `net.c`, reading the epoch on connect and resetting counters per connection — `main.c` and the `ab_net_*` API unchanged.
**Requirements:** R20b, R21, KTD1, KTD2.
**Dependencies:** U24 (C helpers), U25 (host peer to test against).
**Files:** `client/source/net.c`, `client/source/net.h`, `client/source/config.h` (PSK hex; `SERVER_HOST` retained as discovery fallback), `client/source/crypto.c`/`.h`.
**Approach:**
- Key source: `config.h` `PAIR_PSK` (64 hex) parsed at startup via `ab_key_from_hex`. (A future `sdmc:/3dsendai/key` mint path is deferred — out of scope; note it.)
- `ab_net_connect`: after TCP connect, if a PSK is configured, `recvExact(8)` the cleartext epoch into static state; reset `s_send_seq = s_recv_seq = 0`.
- `ab_net_send`: if PSK active, build the AgentBus frame into a scratch buffer, `ab_seal_frame(key, DIR_3DS_TO_HOST, epoch, s_send_seq++, ...)`, length-prefix, `send_all`. Else plaintext as today.
- `ab_net_poll`: if PSK active, read the outer length, `ab_open_frame(key, DIR_HOST_TO_3DS, epoch, s_recv_seq++, ...)`; on -1 disconnect (mirrors host close); else dispatch the recovered plaintext frame to the existing callback. Enforce `len > RXBUF` drop already present.
- Nonce per frame from a CSPRNG. **libctru note:** use `PS_GenerateRandomBytes` via `psInit()` (add to `ab_net_init`/startup) — matches 3Base's RNG source.
**Patterns to follow:** 3Base `hal/net.c` `recvExact`/`sendAll` idle-timeout loops; existing `net.c` static-state + negative-error conventions.
**Test scenarios (host-compilable C core + integration):**
- Reuse `crypto_test.c`/`frame_test.c` from U23/U24 for the pure seal/open path (host `cc`, no devkitPro).
- Integration proven via U25's host test with a crypto MockDevice standing in for the client wire behavior (device seq/dir/epoch usage matches host expectation).
- `Test expectation: none` for the libctru glue itself (socket/PS calls) — runtime-unverified without hardware, per repo convention; assert via build + the pure-core KAT.
**Execution note:** Rebuild via devkitARM Docker after each net.c change; keep `<fcntl.h>` included where `O_NONBLOCK` is set.
**Verification:** devkitARM `make` clean/warning-free; host-compiled C KAT passes; host test with crypto MockDevice green.

### U27. Zero-config UDP discovery (host responder + client prober)

**Goal:** The 3DS finds the host by UDP broadcast; the host replies with its TCP port. No hardcoded IP required; `SERVER_HOST` becomes a timeout fallback.
**Requirements:** R21, KTD5, and domain separation (KTD4).
**Dependencies:** U23 (crypto + discovery constants), U24 (seal/open + `"3dsendai-dsc-v1"` AAD).
**Files:** `host/src/server/discovery.ts`, `host/bin/host.ts` (start responder, env `SENDAI_DISCOVERY_PORT`, `SENDAI_DISCOVERY=off` opt-out), `host/src/app.ts` (wire), `client/source/discovery.c`/`.h`, `client/source/net.c` (discover before connect), `client/source/main.c` (reconnect seam), `client/source/config.h`, `host/test/discovery.test.ts`, `client/test/discovery_test.c`.
**Approach:**
- Datagram: `MAGIC "ag3n"(4) ‖ TYPE(1) ‖ sealed-frame`, AAD context `"3dsendai-dsc-v1"`, seq 0. `TYPE 0x01` probe (3DS→host, plaintext = 8-byte challenge), `TYPE 0x02` reply (host→3DS, plaintext = `challenge(8) ‖ hostTcpPort(2 BE)`).
- Host `discovery.ts`: Bun `udpSocket` bound to `41337`, `SO_BROADCAST`/reuse; on a datagram, `parseProbe` (verify magic/type, open under discovery AAD, plaintext length exactly 8); reply unicast to source with `buildReply` carrying `SENDAI_PORT`. Ignore anything that doesn't unlock. When no PSK is configured, discovery is disabled (nothing to authenticate with) — document that discovery implies a PSK.
- Client `discovery.c`: `ab_discover(timeout, out_ip, out_port)` — build probe, `SOCK_DGRAM` broadcast to `255.255.255.255:41337`, poll for a reply that matches the challenge, return dotted-quad (from `recvfrom` source) + port. **Retry** up to 3× (3Base's single-shot was fragile). Non-blocking / frame-budgeted so the 60fps UI never freezes.
- `main.c` reconnect seam: when disconnected and countdown elapsed, try `ab_discover` first; on success feed the result into the existing `ab_net_connect`; on timeout fall back to `SERVER_HOST`.
**Patterns to follow:** 3Base `core/discovery.c` fixed-length probe bound (buffer safety), `adapters/udp.ts` challenge-match; 3dsendai `main.c` countdown state machine. Add `<fcntl.h>` for the non-blocking UDP socket.
**Test scenarios:**
- `discovery.test.ts`: a probe built with the PSK gets a reply carrying the configured TCP port; the reply's challenge matches.
- Wrong PSK probe → no reply.
- Garbage/short datagram → ignored, no crash.
- Domain separation: a **TCP** frame's sealed bytes spliced into a discovery datagram → rejected (different AAD context), and vice-versa.
- `discovery_test.c`: build-probe / parse-reply KAT byte-exact against the TS-produced vectors; wrong key and bad length rejected.
**Verification:** `bun test host/test/discovery.test.ts` green; C discovery KAT passes; devkitARM build clean.

### U28. C core test harness in CI + GitHub Actions workflow

**Goal:** Give the repo the CI it currently lacks so "CI green" is a real gate: host-compiled C KAT (no devkitPro needed), the Bun suite, codegen-drift check, and a devkitARM Docker build.
**Requirements:** R21 (verifiable), project quality bar; required by the LFG end state.
**Dependencies:** U23–U27 (the tests they add).
**Files:** `.github/workflows/check.yml`, `client/test/vendor/unity/*` (vendored Unity, MIT), `client/test/run.sh` (host-compile + run each `*_test.c`), `client/Makefile` (unchanged; Docker build invoked from CI), root `package.json` (add `test:c`/`check` convenience scripts).
**Approach:**
- Vendor Unity (MIT) for the C KAT, keep it out of any C lint globs.
- `client/test/run.sh`: for each `*_test.c`, host-`cc` compile `unity.c + monocypher.c + crypto.c + discovery.c + test`, run, aggregate failures. This is what makes Monocypher's output cross-checkable against libsodium's KAT constants in one CI run.
- `check.yml`, three jobs on `ubuntu-24.04`: **host** (bun 1.3.14, `bun install --frozen-lockfile`, `bun run codegen` + `git diff --exit-code` drift gate, `tsc --noEmit`, `bun test`); **ccore** (`client/test/run.sh`); **build3ds** (`docker run --rm -v $PWD/client:/work -w /work devkitpro/devkitarm:latest make`, upload `.3dsx` artifact). Pin the devkitARM image by digest for reproducibility.
- Do **not** introduce biome/ls-lint/clang-tidy — 3dsendai doesn't use them; stay within existing tooling (global "don't add frameworks" rule).
**Patterns to follow:** 3Base `tools/test.sh` host-compile approach and `check.yml` job split — **reimplemented**, not copied (GPL scaffolding).
**Test scenarios:** `Test expectation: none — this unit is CI config + a test runner.` Its correctness is that all three jobs pass on the branch and the drift/`git diff` gate catches an un-regenerated header.
**Verification:** push the branch; all three CI jobs green.

### U29. End-to-end encrypted agent loop + docs

**Goal:** Prove the merged whole: an encrypted, auto-discovered session driving a real agent, and update the docs/config/tracker so the repo tells the truth.
**Requirements:** R1, R5, R7, R16, R20a/b, R21; AE4 (traffic not cleartext, unpaired device can't drive).
**Dependencies:** U25, U26, U27.
**Files:** `host/test/e2e.test.ts` (encrypted end-to-end), `README.md`, `CONCEPTS.md` (add Secure transport / Discovery / PSK / Epoch terms), `client/source/config.h`, `client/README.md`, `docs/plans/2026-07-01-001-...-plan.md` (mark U19/S2 done, record the XChaCha20 decision superseding mbedTLS-vs-tunnel), `docs/PROTOCOL.md` (new — 3dsendai wire contract incl. secure frame + discovery).
**Approach:**
- E2E test: PSK-configured host + crypto MockDevice run a full ATTACH→prompt→streamed-output loop against the existing fake adapter, asserting no plaintext AgentBus frame ever hits the wire (inspect raw bytes: no readable JSON) — this is the machine-checkable form of AE4.
- Docs: document `SENDAI_PSK` (64 hex), discovery on/off, the `"is my traffic encrypted"` answer, and that discovery implies a PSK. Write `docs/PROTOCOL.md` from this plan's HTD as the living wire spec. Keep the honest-status tone of the existing README.
**Patterns to follow:** `host/test/e2e.test.ts` AE1/AE2 style; the M1 plan's build-tracker table format.
**Test scenarios:**
- Full encrypted loop: attach → prompt → ≥1 output_chunk, all sealed.
- AE4: raw captured bytes contain no cleartext JSON; a device with the wrong PSK cannot attach.
- Regression: the whole `bun test` suite green with and without PSK.
**Verification:** `bun test` green; `tsc --noEmit` clean; devkitARM build clean; README/CONCEPTS/tracker updated and accurate.

---

## Requirements Traceability

| Requirement | Units |
|---|---|
| R1 wire protocol | U24, U29 |
| R2 client/agent-agnostic | U23, U24 |
| R3 single framed TCP | U24 |
| R4 deployable host | U25 |
| R5 durable sessions/reconnect preserved | U25, U29 |
| R7 adapters unchanged | U29 |
| R20a authenticated from M1 | U25 |
| R20b encrypted when remote | U23–U26, U29 |
| R21 no hardcoded keys/ports | U25, U26, U27 |
| AE4 unpaired can't drive, not cleartext | U29 |

## Scope Boundaries

**In scope:** frame-level XChaCha20-Poly1305 (libsodium host / Monocypher client), per-connection epoch + seq AAD, discovery-vs-transport domain separation, listener frame-length cap, zero-config UDP discovery with retry + `SERVER_HOST` fallback, single-sourced crypto constants, C core KAT + GitHub Actions CI, encrypted end-to-end test, docs.

**Deferred to follow-up work:**
- On-device key mint/storage (`sdmc:/3dsendai/key`) + on-screen hex display + a pairing UX — v1 uses a `config.h` PSK. (U19 "pairing UX" half.)
- Forward secrecy / key rotation (static PSK is the v1 threat model: LAN eavesdropper, not device theft).
- Subnet-crossing discovery (directed broadcast / mDNS) — `255.255.255.255` is LAN-only by design.
- Encrypting the pre-auth `MSG.ERROR` path when no PSK is set (plaintext path is dev-only).

**Outside this product's identity:** unchanged from origin (no terminal, no on-device agent, no IDE).

## Risks & Mitigations

- **libsodium-wrappers under `bun build --compile`.** First host runtime dep; WASM init is async. Mitigation: `cryptoReady()` awaited at host boot in `bin/host.ts`; verify the compiled single-binary boots in U28 CI (build job) and locally before U29 sign-off.
- **C client record size vs `RXBUF` (16 KiB).** AEAD adds 40 bytes/record; large output frames must stay under cap. Mitigation: document the bound in U24; host already chunks output; add an assertion in the C frame helper.
- **UDP discovery freezing the 60fps UI.** Mitigation: non-blocking, frame-budgeted poll with a bounded retry, per U27; never block the render thread.
- **Epoch handshake vs reconnect/replay (AE1).** New epoch per TCP connection must not break app-layer cursor replay. Mitigation: explicit AE1 regression test in U25; epoch lives at transport, cursor at app layer — orthogonal by construction.
- **License drift.** Mitigation: reimplement from spec/KAT; only Monocypher (BSD/CC0) is copied; VENDOR.md records provenance (U23).

## Dependencies / Assumptions

- Bun 1.3.14 (matches repo + 3Base); `libsodium-wrappers@^0.8.4`.
- Monocypher 4.0.2 vendored; devkitARM via Docker for the client build.
- PSK shared out-of-band between host (`SENDAI_PSK`) and client (`config.h`) for v1; discovery requires a PSK.
- Runtime device verification remains hardware-gated per repo convention; C logic is proven via host-compiled KAT + build.

## Sources / Research

- Origin requirements: the original requirements (removed in docs cleanup; see git history) (R20a/b, R21, M4).
- 3Base `PROTOCOL.md` + KAT vectors (reimplemented, not copied): XChaCha20-Poly1305 frame, AAD scheme, UDP discovery, Monocypher 4.0.2 vendoring, host-compiled C KAT. GPL-3.0-or-later — only the design and vectors are used.
- Institutional learnings: `docs/solutions/build-errors/devkitpro-3ds-homebrew-cross-compile.md` (LD/ARCH/`<fcntl.h>`, build-early), `docs/solutions/architecture-patterns/driving-coding-agent-clis-from-a-host.md` (single-source codegen + golden vectors), `docs/solutions/developer-experience/bun-and-workflow-tooling-gotchas.md` (explicit `Uint8Array` typing).
- 3dsendai surfaces: `protocol/src/frames.ts`, `host/src/server/{index,connection,auth}.ts`, `host/src/app.ts`, `client/source/{net.c,main.c,config.h}`, `protocol/codegen/*`.
