# fable-lessons — run notes for plan 2026-07-07-004

- secure-vectors.json has no generator script; it's hand-curated with fixed nonces. Compute new sealed vectors with a scratch script calling sealRecord() with an injected nonce, then paste hex into both the JSON and frame_test.c.
- client/test/run.sh output: pipe through grep for the specific test binary; tail alone hides earlier suites.
- tmux 3.7 -CC control clients ignore pty TIOCSWINSZ; only refresh-client -C sizes them. Bridge bootstraps at spawn.
- e2e-tmux.test.ts AE4 is flaky at baseline (resync "$ " satisfies waitFor before the marker) — pre-existing, not from plan-004 work; flagged as a spun-off task.
- Verifier subagents can't run docker builds; record devkitARM build results in the main session so handoffs cite them.
- QR RS remainder: divisor coefficients must be taken highest-to-lowest excluding the leading 1; lowest-first indexing gives ECC failure on every symbol. quirc round-trip caught it immediately — always close the loop with a real decoder before committing an encoder.
- tmux 3.7 -CC winsize lesson applies to scan test comments too; attribute behavior to the mechanism a probe proved, not the one the plan predicted.
- strict tsc rejects `arr[i] ^= x` on Uint8Array (TS2532); write `arr[i] = arr[i]! ^ x`.
