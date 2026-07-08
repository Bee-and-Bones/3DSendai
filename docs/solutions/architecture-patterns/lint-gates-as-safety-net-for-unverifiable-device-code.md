---
title: "Lint and CI gates are the safety net for a hardware-gated project, not a style nicety"
module: repo-wide (protocol, host, client)
date: 2026-07-08
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - Deciding whether a lint/static-analysis layer is worth the setup cost on this repo
  - Adding a new lint rule, allowlist entry, or CI gate to check.yml
  - Wondering why a filename or identifier gets renamed to satisfy ls-lint/clang-tidy/biome
  - Onboarding to 3DSendai and asking "why so many gates for a homebrew client?"
tags:
  - ci
  - lint
  - static-analysis
  - clang-tidy
  - biome
  - ls-lint
  - codegen
  - devkitpro
---

## Context

3DSendai has two properties that make automated gates load-bearing rather than
cosmetic: (1) a chunk of the C client only *compiles* in CI — sockets, render,
audio, LED are libctru-only and, per AGENTS.md invariant #5, **runtime
UNVERIFIED without hardware**; and (2) the wire format is a byte-exact contract
between two languages (TS codec, hand-written C) that share no runtime code.
Neither property is fixed by "being careful." Both are fixed by machines that
fail the build.

## Guidance

**1. Static analysis is the only safety net CI can offer for device code.**
`client/test/run.sh` proves the pure-C core (`term.c`, `crypto.c`, `discovery.c`,
`json.c`, `input.c`) against host-compiled KATs — but anything touching a
libctru service (`ab_net_*`, render, `mcuHwc`, `ndsp`) cannot be exercised at
all without a physical 3DS, which is user-owned and user-gated (project.md).
On that code, `-Wall -Wextra` warning-free, clang-format, cppcheck, and
clang-tidy aren't style preferences — they're standing in for the tests you
literally cannot run in CI. A lint violation in `ab_net_connect` is a bug class
(uninitialized read, signed/unsigned compare, format-string mismatch) you would
otherwise only meet at 3am on the one 3DS in the house. Treat every warning
in libctru-glue files as equivalent in severity to a failing test, because for
that code, it's the only check that exists pre-hardware.

**2. The protocol drift gate is "linting" in the broad sense: a machine enforcing
byte-identical behavior across languages.** `protocol/codegen/message-types.source.ts`
is the single source; `bun run codegen` regenerates `protocol/src/*.generated.ts`
**and** `client/source/protocol.h`, and CI runs codegen then `git diff --exit-code`
on both outputs (invariant #1). Golden vectors (`protocol/test/golden/*.json`,
mirrored as hardcoded hex in `client/test/{crypto,frame,discovery}Test.c`) are
the same idea applied to bytes instead of filenames: a human "I checked they
match" is worth nothing across a TS/C boundary with no shared runtime — the
build must fail the instant they don't. Generated files and golden vectors are
machine-owned for exactly the reason identifiers are machine-linted: the source
of truth lives in one place, and every other copy is a derived artifact whose
only job is to match it.

**3. Lint scope = police what you own, allowlist what you don't — same
principle in both languages.** onoSendai's `console/.clang-tidy` restricts
`readability-identifier-naming` to files matched by `HeaderFilterRegex:
'^/work/(include|src)/[^/]+$'` — it never flags libctru's `APT_*`, `MCUHWC_*`,
`svcCloseHandle`, `hidKeysDown`, because those are declared in libctru's own
headers, outside the filter; 3DSendai's C client only *calls* them, so they're
never in scope to rename. The TS mirror of this is `biome.json`'s
`useNamingConvention`: `function`/`variable`/`const`/`typeLike` conventions
enforce camelCase/PascalCase on identifiers we declare, but
`objectLiteralProperty` and `typeProperty` selectors additionally allow
`snake_case` — because those names mirror a *foreign* wire format, not code we
wrote. herdr's NDJSON keys (`pane_id`, `workspace_id`, `agent_status`,
`focused_pane_id` — invariant #8) and agent-CLI JSON (`session_id`, `is_error`)
are permanent fixtures of the wire surface, since herdr is always the backend
this project talks to. Renaming those keys to satisfy a linter wouldn't fix
anything — it would break parsing against a format we don't control. When an
exception is unavoidable among names you *do* own, it's an explicit, narrow
allowlist (`FunctionIgnoredRegexp: '^(main|userAppInit)$'`, an `ls-lint`
`regex:(...)` entry, a site-level `biome-ignore` with a stated reason) — never
a blanket rule-disable that also hides real drift in code you do own.

**4. Filename casing is enforced the same way, even when it means churn.**
`ls-lint` pins `.c`/`.h`/`.ts`/`.sh` to camelCase per directory (onoSendai's
`.ls-lint.yml` is the reference: `console/src`, `host/src`, even
`.github/workflows/*.yml`). Consistency across the fleet's 3DS repos (onoSendai,
3Drop, 3DSendai) is worth a rename — a scanner that says "camelCase everywhere
except this one legacy directory" stops being useful the first time someone
has to remember the exception by hand.

**5. A lint layer without teeth in CI is theater.** Each layer must be provably
red on a violating tree and green on a clean one, and wired into
`.github/workflows/check.yml` — not a script that exists in the repo but never
runs. The full verify gate before shipping anything is `bun test` +
`bun run typecheck` + `client/test/run.sh`, plus a clean devkitARM `make`
(`docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make`)
for any `client/` change. A lint config nobody runs in CI is worse than no
config — it creates the impression of a safety net that isn't actually catching
anything.

## Why This Matters

Every other project can lean on "we'd catch it in testing." This one can't, for
a real fraction of its code — the device half only compiles in CI and only
*runs* on hardware someone has to physically hold and grant access to. That
turns static analysis from a taste question into the load-bearing check for an
entire code path, and turns the codegen/golden-vector drift gates into the
mechanism that keeps a two-language wire contract from silently diverging. The
scope discipline (own-code only, explicit allowlists for exceptions) is what
keeps the gates useful instead of noisy: a linter that also complains about
`hidKeysDown` or `session_id` trains people to ignore its output, which is the
one failure mode that defeats the entire point.

## When to Apply

Any time you're deciding whether a new gate is worth adding to `check.yml`, or
whether a lint failure is "just style": if the failing code is
libctru/hardware-only, or it's on the TS↔C wire boundary, treat the gate as a
correctness check, not a nit. When adding an allowlist entry (clang-tidy
`IgnoredRegexp`, biome `biome-ignore`, ls-lint `regex:`), require it to name a
*foreign* contract (a library symbol, a herdr/agent-CLI field) — if it's
naming your own code, fix the code instead of the config.
