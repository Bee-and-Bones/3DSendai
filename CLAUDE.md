# CLAUDE.md

The repo's operating rules for coding agents live in **[AGENTS.md](AGENTS.md)** —
that is the single source of truth. Read it before touching the protocol, the C
client, or the golden vectors.

Quick orientation for Claude Code specifically:

- **What this is:** 3DSendai — a Nintendo 3DS as a remote terminal + macropad for
  your own tmux sessions. Spiritual successor to [3Base](https://github.com/MadeOfBees/3Base),
  GPL-3.0. Three packages: `protocol/` (TS wire codec), `host/` (Bun/TS bridge +
  server), `client/` (C/libctru homebrew app).
- **Verify like this:** `bun test` + `bun run typecheck` + `client/test/run.sh`,
  and for any `client/` change a clean devkitARM build
  (`cd client && docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make`).
- **Do not hand-edit generated files** (`protocol/src/*.generated.ts`,
  `client/source/protocol.h`) — run `bun run codegen`. A CI drift gate enforces it.
- **Changing sealed bytes** (AAD contexts, AEAD inputs, payload shapes) means
  regenerating the golden vectors *and* the hardcoded hex in the C KATs — see
  AGENTS.md invariant #2.
- **The C client's device code is runtime-unverified without hardware.** Cover
  pure-C logic with host KATs; don't claim on-device behavior works from a clean
  build alone.

Everything else — invariants, conventions, security posture — is in AGENTS.md.
