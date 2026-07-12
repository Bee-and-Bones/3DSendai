# AGENTS.md — 3DSendai

Operating rules for coding agents (and humans) working in this repo. Read this
before touching the protocol, the C client, or the golden vectors. This is the
canonical source; `CLAUDE.md` points here.

3DSendai turns a Nintendo 3DS into a **remote terminal + macropad for your own
tmux sessions**. A spiritual successor to [3Base](https://github.com/MadeOfBees/3Base);
**GPL-3.0** — keep new code compatible and preserve vendored license headers.

## Layout

- `protocol/` — `@agentbus/protocol`. The AgentBus wire format + TS codec + the
  single-source codegen + golden vectors. Pure TS, no build step.
- `host/` — `@agentbus/host`. Bun/TypeScript. The tmux bridge (`src/tmux/`), the
  encrypted/token server (`src/server/`), discovery, and the retained structured
  agent stack (`src/adapters/`, `src/registry/`, `src/policy/`, `src/capability/`).
- `client/` — the C/libctru 3DS homebrew app (devkitPro). Terminal emulator
  (`term.c`), input, UI, alerts, and the vendored crypto.
- `docs/` — `PROTOCOL.md` (wire contract), `plans/`, `brainstorms/`, `solutions/`
  (postmortems worth reading before touching the area they cover).
- `CONCEPTS.md` — the project glossary. Use these names.

Naming note: the app/project is **3DSendai** (`3dsendai` in identifiers,
`SENDAI_*` env vars). The wire protocol keeps its own name **AgentBus** and the
`@agentbus/*` package scope — that's deliberate, not a missed rename.

## Commands

```bash
bun install
bun test                 # host + protocol suite (bun:test)
bun run typecheck        # tsc --noEmit, strict
bun run codegen          # regenerate message-types + crypto constants (TS + C header)
client/test/run.sh       # host-compiled C core KATs — no devkitPro needed
# rebuild the 3DS app (needed to verify any client/ C change):
cd client && docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make
```

Before shipping any change: `bun test` + `bun run typecheck` + `client/test/run.sh`
green, and if you touched `client/`, a clean devkitARM `make`.

## Load-bearing invariants (these break silently if ignored)

1. **The protocol is single-sourced. Never hand-edit generated files.** Message
   type codes and crypto/discovery constants live in
   `protocol/codegen/message-types.source.ts`. Run `bun run codegen`; it
   regenerates `protocol/src/*.generated.ts` **and** `client/source/protocol.h`.
   A drift gate in CI (`bun run codegen` + `git diff --exit-code`) fails if they
   diverge. Message-type values are **assigned once, never renumbered** (down
   types 1+, up types 64+; next free: down 13, up 73).

2. **Golden vectors are the cross-language contract.** The TS codec and the C
   client must encode/decode byte-identically. Plaintext vectors:
   `protocol/test/golden/vectors.json` (regen: `bun run protocol/test/generateGolden.ts`).
   Encrypted/discovery vectors: `protocol/test/golden/secure-vectors.json`, mirrored
   in `client/test/{frame,discovery}Test.c`. If you change anything that affects
   sealed bytes — the AAD context strings, an AEAD input, a payload shape — you
   must regenerate the vectors **and** update the hardcoded hex in the C KATs
   (`cryptoTest.c`, `frameTest.c`, `discoveryTest.c`), then confirm
   `client/test/run.sh` still passes (that's libsodium and Monocypher agreeing).

3. **The AAD context strings are 15 bytes** (`3dsendai-msg-v1` / `3dsendai-dsc-v1`).
   The C side hardcodes `AB_AAD_CONTEXT_BYTES` (crypto.h) — keep it equal to the
   actual context length, and keep both contexts the same length, or C and TS
   produce different AADs and the wire silently breaks.

4. **C client: build early, in the real toolchain.** 3DS code cannot be validated
   by inspection — the first devkitARM `make` is where the bugs are. Keep
   `LD := $(CC)` (C-only link) and the exact arch flags
   `-march=armv6k -mtune=mpcore -mfloat-abi=hard`. libctru headers are **not**
   transitive — every new file using a service (`<fcntl.h>` for sockets, ndsp,
   mcuHwc, apt) must include its own header. Warning-free (`-Wall -Wextra`) is the
   bar. The Makefile auto-globs `source/*.c`, so new files need no Makefile edit.

5. **Pure-C core vs libctru glue.** Parsers and codecs (`term.c`, `crypto.c`,
   `discovery.c`, `json.c`, `input.c`) are **pure C, no libctru**, so they
   host-compile into the KAT harness (`client/test/run.sh`, extend via the source
   list). Anything touching sockets/render/audio/LED is libctru-only and
   **runtime-unverified without hardware** — say so in the file header
   (`COMPILES with devkitPro; runtime UNVERIFIED without hardware`) and cover the
   pure logic with a host KAT instead.

6. **The tmux bridge needs a PTY.** `tmux -CC` calls `tcgetattr` and exits on a
   bare pipe, so `src/tmux/bridge.ts` runs it via `src/tmux/tmux-pty.py`
   (`pty.fork()`, not `pty.spawn()`). Build the control-mode parser from the
   captured fixtures in `host/test/fixtures/tmux-cc/`, never from memory of the
   format. `%output` is backslash-octal-escaped; lines are CRLF.

7. **Strict-tsc typed arrays.** Annotate byte-buffer fields explicitly as
   `Uint8Array` (`private buf: Uint8Array = new Uint8Array(0)`). Inference gives
   `Uint8Array<ArrayBuffer>` and `.subarray()`/`.slice()` reassignment fails to
   compile with an error pointing far from the cause.

8. **The herdr backend is built from captured wire facts, not herdr's docs.**
   The api socket answers one request per connection (docs claim persistent
   connections — 0.7.2 does not do that); `events.subscribe` connections stream
   but take exactly one subscribe each; event names are mixed dotted/underscored.
   Build against the fixtures in `host/test/fixtures/herdr/` (pin + facts in its
   README) and refresh them when bumping the pinned herdr. Frames from the
   terminal control channel must pass through `stripOsc` before the device —
   `term.c` spills OSC bodies as printable text.

## Conventions

- **TS:** named exports, `.ts` import extensions, factory functions over classes
  except for stateful primitives, file-header comments citing the plan unit
  (`U31`, etc.). No new runtime deps without a real reason (`libsodium-wrappers`
  is the only one).
- **C:** 2-space indent, `ab_`-prefixed public functions, `s_` module statics,
  `g_` globals, fixed static buffers with bounded copies, negative-int error
  returns.
- **Tests:** `bun:test` with hand-rolled fakes (no mocking libraries); real
  loopback sockets for e2e; Unity for the C KATs. Prove cross-library crypto with
  fixed known-answer vectors, not round-trips alone.
- **Docs:** plans in `docs/plans/YYYY-MM-DD-NNN-<type>-<slug>-plan.md`; U-IDs and
  R-IDs are never renumbered. Capture durable learnings in `docs/solutions/`.

## Security posture

Transport is XChaCha20-Poly1305 with a 32-byte PSK; the AEAD tag is the
authenticator when a PSK is set, token auth on the loopback dev path. Don't add a
plaintext path around the sealed transport, don't log the PSK, keep the
length-cap-before-buffering on the listener. Threat model and the known
asymmetric-replay caveat are in `docs/PROTOCOL.md` — read it before touching
crypto.
