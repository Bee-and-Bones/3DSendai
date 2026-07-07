# fable-lessons — run notes for plans 004/005

- secure-vectors.json has no generator script; it's hand-curated with fixed nonces. Compute new sealed vectors with a scratch script calling sealRecord() with an injected nonce, then paste hex into both the JSON and frame_test.c.
- client/test/run.sh output: pipe through grep for the specific test binary; tail alone hides earlier suites.
- tmux 3.7 -CC control clients ignore pty TIOCSWINSZ; only refresh-client -C sizes them. Bridge bootstraps at spawn.
- e2e-tmux.test.ts AE4 is flaky at baseline (resync "$ " satisfies waitFor before the marker) — pre-existing, not from plan-004 work; flagged as a spun-off task.
- Verifier subagents can't run docker builds; record devkitARM build results in the main session so handoffs cite them.
- QR RS remainder: divisor coefficients must be taken highest-to-lowest excluding the leading 1; lowest-first indexing gives ECC failure on every symbol. quirc round-trip caught it immediately — always close the loop with a real decoder before committing an encoder.
- tmux 3.7 -CC winsize lesson applies to scan test comments too; attribute behavior to the mechanism a probe proved, not the one the plan predicted.
- strict tsc rejects `arr[i] ^= x` on Uint8Array (TS2532); write `arr[i] = arr[i]! ^ x`.
- Stt.finalize() is synchronous by contract; whisper backend uses Bun.spawnSync (whisper-server HTTP variant needs an async seam — deferred with streaming STT).
- Buffer a whole PTT utterance before resampling: chunk-wise linear resample seams degrade STT; VoiceRoute concatenates then resamples once.
- Approval timeout deny must guard on pending-map delete (fires once even if fireAll runs twice).
- herdr 0.7.2's api socket is one-request-per-connection (response then immediate close), not the persistent multiplexed connection its docs describe; `events.subscribe` is the exception (stays open, one subscribe per connection — a second subscribe drops the connection with no response). Request ids must be strings.
- herdr push-event names are mixed-shape: per-pane subscribed events are dotted (`pane.agent_status_changed`), global lifecycle events underscored (`pane_exited`). Don't normalize by assumption; match both as captured.
- herdr 0.7.2 shipped `terminal session control/observe` (NDJSON over plain pipes, per-pane live ANSI frames + input/resize, `--takeover` single-controller semantics) the same day plan-005 was written — it obsoleted the plan's whole PTY-attach-vs-polling fork. When targeting a fast-moving pre-1.0 tool, re-check its release feed on spike day before executing a researched design.
- herdr control-channel frames are rendered screen-state deltas (20k output lines collapse to ~3 frames) and every frame opens with OSC 8 + DECSET 2026; term.c spills OSC bodies as printable text, so the herdr bridge strips OSC host-side.
- `pane.send_input {text, keys}` is text-then-keys and atomically validated; `ctrl-c` is not a herdr key name — raw control bytes only exist on the control channel.
