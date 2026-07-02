---
date: 2026-07-01
status: active
origin: docs/brainstorms/2026-07-01-3ds-tmux-terminal-macropad-requirements.md
---

# feat: 3DS as a Remote tmux Terminal + Macropad

> Build the product pivot from `docs/brainstorms/2026-07-01-3ds-tmux-terminal-macropad-requirements.md`: the 3DS becomes a remote terminal for the user's own tmux sessions (host bridges via tmux control mode), plus a toggleable macropad and lid-closed attention alerts. Reuses the shipped encrypted transport + discovery unchanged. Two feasibility spikes gate the build.

## Summary

The user runs `tmux new -s <name>` in their own terminal. The host attaches to that tmux server as a **control-mode client** (`tmux -CC`) — over plain pipes, no pty — and bridges the session to the 3DS: pane bytes stream down as terminal-data frames, the device's keystrokes go back up and become `send-keys`. The 3DS renders a scrolling terminal on the top screen, drives it with a bottom-screen control strip + physical buttons, and toggles into a macropad mode of configurable quick-action buttons. Attention events (a tmux bell, a pane dying) raise a sound and the hinge LED, working with the lid closed.

This is additive at the protocol/transport layer (three new AgentBus message types over the existing sealed frames) and swaps the host's *session source* from the structured agent adapters to a new tmux bridge. The structured stack (per-agent normalizers, approval policy, capability negotiation) stays in the tree but off-path — a possible future "structured mode."

## Problem Frame

v1 treated the 3DS as a structured controller that drives host-spawned headless agents and deliberately avoids being a terminal. Building against real use, the owner wants the opposite shape: keep the tmux workflow untouched and make the 3DS a way to *pick up and drive that exact session* from the couch, plus a physical quick-action pad at the desk. The brainstorm records this as a deliberate identity reversal (see origin: "Retired boundary"); this plan builds it.

Two things gate feasibility and are therefore planned as spikes before the large units: whether tmux control mode delivers usable pane fidelity through a custom parser (S3), and whether a hand-rolled ANSI renderer is legible for agent output at 400x240 on real hardware (S4).

---

## Key Technical Decisions

- **KTD1 — tmux control mode over `Bun.spawn` pipes; no pty.** Control mode (`tmux -CC attach -t <name>`) is a line-oriented protocol over stdin/stdout designed to run over ssh/pipes, so it needs no pseudo-terminal. This sidesteps `node-pty` entirely (a native addon with unresolved Bun compatibility). The host spawns the control-mode client with piped stdio and speaks the protocol directly. (see origin: "The host is a tmux client, via control mode")

- **KTD2 — the device terminal is a scrolling-log renderer, not a full alt-screen TUI.** A minimal ANSI/SGR state machine (CSI parsing, cursor addressing, basic colors, line wrap) over a fixed cell grid + scrollback ring. Line-oriented colored output (a shell, an agent streaming turns) is the target and is proven feasible by DSSH. Dense full-redraw alt-screen apps (vim, htop, and possibly an agent's own fancy TUI) are **stretch/out-of-scope** — they may render poorly or not at all. The system font is not monospaced; a bundled monospace bitmap font is required for column alignment.

- **KTD3 — tmux owns scrollback and persistence; the host does not replicate it.** On attach/reattach the host seeds the device with the pane's current contents (`capture-pane -e -p`) then streams live `%output`. The v1 `DurableBuffer` ring is **not** used for terminal data — reconnect resyncs to tmux's authoritative buffer (see origin: R28). The ring may still record alert/session-list frames if useful.

- **KTD4 — terminal bytes travel hex-encoded inside the canonical-JSON frame.** Pane bytes are hex-encoded into a JSON string field, reusing the existing `toHex`/`fromHex` and the C-side string handling, and chunked below `MAX_SECURE_PLAINTEXT` (16340) with the same recursive-split discipline as `splitOutputText`. Hex doubles size; that is acceptable for control-mode `%output` events (typically small) at LAN throughput. A raw-binary frame variant that bypasses `canonicalJSON` is the **escape hatch** if the spike shows throughput hurts — held as an Open Question, not built now, to preserve the golden-vector/KAT discipline.

- **KTD5 — the session list is delivered as one `SESSION_STATE` per session, not a JSON array.** The client's `json.c` is a naive non-array scanner; rather than add array parsing to C for v1, the host emits a `SESSION_STATE` frame per tmux session (the parser handles one object at a time). `SESSION_LIST` is retained only as a "list boundary/clear" signal. Adding a real C array parser is deferred.

- **KTD6 — lid-closed survival is built here; it does not exist today.** The origin doc assumed an NDM WiFi lock already held through sleep. It is not in the client source. This plan adds `aptSetSleepAllowed(false)` (the gate that keeps CPU/DSP/services alive with the lid shut) and, where needed, the NDM lock. Audio via `ndsp` requires a `sdmc:/3ds/dspfirm.cdc` dump at runtime, so **the LED (MCUHWC) is the guaranteed lid-closed channel and sound is best-effort** — the device degrades to LED-only when audio is unavailable.

- **KTD7 — macropad buttons resolve to keystrokes, not prompts.** The `.pad` layout format, the `MACROPAD_LAYOUT` frame, and the layout-push plumbing are reused. But `layouts/intent.ts` maps intents to English *agent prompts* (structured-mode only); the raw path needs a new intent→**keystroke/string** resolution (approve = `y\r`, interrupt = `\x03`). Buttons send `KEYSTROKE` frames, same as the control strip.

- **KTD8 — reuse the entire encrypted transport, discovery, codegen, and golden/KAT discipline unchanged (see origin: R41).** New message types are additive entries in the single-source list; terminal/keystroke/alert frames are ordinary sealed records. No new plaintext path.

---

## High-Level Technical Design

Component + data flow (host bridges the user's tmux to the device over the existing sealed transport):

```
  desk terminal                 host (Bun)                          3DS client (C)
  ------------                  ----------                          --------------
  $ tmux new -s api             TmuxBridge:                         Terminal mode:
        |                         spawn `tmux -CC attach`             VT/ANSI parser -> cell grid
        v                         parse control mode:                 top-screen render + scrollback
  [ tmux server ] <--- %output --- unescape -> TERMINAL_DATA(hex) --> render
        ^                         list-sessions -> SESSION_STATE* --> session picker
        |                         %bell / pane-dead -> ALERT_SIGNAL -> sound + hinge LED (lid-closed)
        |                                                             Macropad mode (toggle):
        +---- send-keys <--- KEYSTROKE <--- control strip / .pad buttons / swkbd
                                  (all frames sealed: XChaCha20-Poly1305, unchanged)
```

Device input model (one focused session; bottom screen has two modes):

```
 Terminal mode bottom screen: [Ctrl][Esc][Tab][<][v][^][>][Ctrl-C][keyboard]   (tap -> KEYSTROKE)
 Physical buttons:            D-pad / L-R = scroll & page the scrollback (no input sent)
 swkbd:                       opens on [keyboard] tap OR tap into a text target -> committed text = KEYSTROKE
 Macropad mode bottom screen: NxM grid from the host-pushed .pad layout (tap -> KEYSTROKE/string)
 Mode toggle:                 a dedicated button/gesture swaps the two bottom-screen renderers
```

Alert decision (host watches the control-mode stream; device raises the signal):

```
 %bell                         -> ALERT_SIGNAL{class: attention}
 pane dead / %exit for pane    -> ALERT_SIGNAL{class: session_ended}
 activity then idle >= T       -> ALERT_SIGNAL{class: likely_done}   (best-effort, tunable)
 routine %output               -> no alert
 device: class -> LED pattern (always) + sound (if dspfirm present); fires with lid closed
```

## Output Structure

New files (repo-relative; existing files modified in place are in per-unit Files):

```
host/src/tmux/
  bridge.ts            # owns the `tmux -CC` child, orchestrates enumerate/stream/keys/alerts
  control-mode.ts      # pure parser: %output unescape, %begin/%end, %-notifications
  keymap.ts            # intent -> keystroke/string resolution for macropad (KTD7)
host/test/
  control-mode.test.ts # parser unit tests against captured `tmux -CC` fixtures
  tmux-bridge.test.ts  # bridge behavior with a fake control-mode stream
  fixtures/tmux-cc/*   # captured control-mode output samples
client/source/
  term.c / term.h      # VT/ANSI parser + cell grid + scrollback
  termfont.c / .h      # bundled monospace bitmap font + glyph atlas
  alert.c / alert.h    # ndsp sound + MCUHWC LED + aptSetSleepAllowed
client/test/
  term_test.c          # host-compiled ANSI-parser KAT (cursor/SGR/wrap cases)
docs/
  PROTOCOL.md          # extend with terminal-data / keystroke / alert / session frames
```

---

## Implementation Units

Grouped into phases. Spikes (S-IDs) gate the phases that depend on them.

### Phase 0 — Feasibility spikes

### S3. Spike: tmux control-mode bridge (host-only)

**Goal:** De-risk the bridge before building it. Prove that a custom parser over `tmux -CC` pipes can stream a live pane, enumerate sessions, inject keystrokes, and observe a bell — and capture real fixtures the parser unit tests will use.
**Requirements:** R26, R27, R40 (feasibility).
**Dependencies:** none.
**Files:** `host/test/fixtures/tmux-cc/` (captured output), a throwaway script under the scratch dir (not committed).
**Approach:** With a real tmux server running a shell, spawn `tmux -CC attach` via `Bun.spawn` piped stdio. Capture raw control-mode output to fixtures covering: `%begin/%end` command replies, `%output` with octal-escaped control bytes, `%window-add`/`%layout-change`/`%session-changed`, a `%bell` (with `monitor-bell on`), and a pane dying. Confirm `send-keys -t <pane> -H <hex>` and literal text both land. Confirm `list-sessions -F '#{session_name}:#{session_id}'` enumerates. Measure round-trip latency and `%output` volume/size under `yes`-style flooding to inform KTD4 (hex-in-JSON vs raw-binary frame).
**Test scenarios:** `Test expectation: none — spike. Output is captured fixtures + a go/no-go note on parser shape and the KTD4 throughput question.`
**Verification:** Fixtures captured; a short written finding confirms control mode is drivable over pipes and states whether hex-in-JSON is throughput-viable or the raw-binary escape hatch is needed.

### S4. Spike: 3DS terminal renderer (on hardware)

**Goal:** De-risk the single largest new component. Prove a minimal ANSI parser + monospace bitmap font renders agent/shell output legibly on the top screen at an acceptable frame cost.
**Requirements:** R29 (feasibility).
**Dependencies:** none.
**Files:** a throwaway `client/source/` spike build (mono font + a hardcoded ANSI sample + scrolling), not the final `term.c`.
**Approach:** Render a fixed cell grid (target ~50-64 cols x 20-28 rows) with a bundled monospace bitmap font via a citro2d glyph atlas; feed it a captured chunk of colored `claude`/`codex` output plus a shell session; implement SGR color, cursor moves, and line wrap only. Measure legibility and per-frame cost; test dirty-rect vs full redraw. Try one alt-screen app (e.g. `htop`) to confirm the KTD2 boundary (expected: poor — documents the limit). Build in the devkitARM Docker image and run on real hardware.
**Test scenarios:** `Test expectation: none — spike. Output is a go/no-go on legibility + column count + redraw strategy, and confirmation of the log-vs-alt-screen boundary.`
**Execution note:** Build in `devkitpro/devkitarm` from the first file; keep `LD := $(CC)` and the exact ARCH flags.
**Verification:** On-hardware screenshot/finding: agent output is readable; a chosen column count, font, and redraw strategy are recorded for U33.

### Phase 1 — Protocol

### U30. Protocol additions: terminal-data, keystroke, alert, session frames

**Goal:** Add the wire vocabulary for terminal mode through the single-source codegen, with golden vectors and a C-side round-trip test.
**Requirements:** R27, R29, R30, R37, R40, R41.
**Dependencies:** informed by S3 (payload shape).
**Files:** `protocol/codegen/message-types.source.ts`, `protocol/src/messages.ts`, `protocol/src/message-types.generated.ts` (regen), `client/source/protocol.h` (regen), `protocol/test/generate-golden.ts`, `protocol/test/golden/vectors.json` (regen), `protocol/test/golden.test.ts`, `client/test/frame_test.c` (extend for the new plaintext frames), `protocol/test/codegen.test.ts`.
**Approach:** Append `TERMINAL_DATA` (down, value 11), `ALERT_SIGNAL` (down, 12) and `KEYSTROKE` (up, 72) to `MESSAGE_TYPES`; run `bun run codegen`. Payloads (KTD4/KTD5): `TERMINAL_DATA {sessionId, hex}` (hex pane bytes, pre-chunked by the host); `KEYSTROKE {sessionId, hex}` (hex key bytes); `ALERT_SIGNAL {sessionId, class}`; reuse per-session `SESSION_STATE {sessionId, name, ...}` for enumeration and keep `SESSION_LIST` as a clear/boundary marker. Add golden vectors for each new type asserted both directions; extend the C KAT to round-trip at least `TERMINAL_DATA` and `KEYSTROKE`.
**Patterns to follow:** `message-types.source.ts` stability rule (never renumber); `generate-golden.ts` -> `vectors.json` -> `golden.test.ts`; `client/test/frame_test.c` KAT shape.
**Test scenarios:**
- Codegen drift: regenerated TS enum, `crypto-constants.generated.ts`, and `protocol.h` match committed files (extend `codegen.test.ts`).
- Golden: each new frame encodes to exact bytes and decodes back (both directions).
- Chunk boundary: a `TERMINAL_DATA` hex payload sized just under `MAX_SECURE_PLAINTEXT` seals into one record; one over forces a second frame.
- C KAT: `frame_test.c` round-trips a `TERMINAL_DATA` and a `KEYSTROKE` frame byte-identically to the TS golden.
**Verification:** `bun test protocol/` green; `client/test/run.sh` green; codegen drift gate clean.

### Phase 2 — Host tmux bridge

### U31. TmuxBridge: control-mode client, session streaming, keystroke injection

**Goal:** The host attaches to the user's tmux, enumerates sessions, streams the focused pane to the device, and delivers device keystrokes back — wired in place of the agent-spawn session source.
**Requirements:** R25, R26, R27, R28, R37, R41.
**Dependencies:** S3, U30.
**Files:** `host/src/tmux/control-mode.ts`, `host/src/tmux/bridge.ts`, `host/src/app.ts`, `host/bin/host.ts`, `host/src/registry/index.ts` (terminal-data/keystroke routing), `host/test/control-mode.test.ts`, `host/test/tmux-bridge.test.ts`, `host/test/fixtures/tmux-cc/*`.
**Approach:** `control-mode.ts` is a pure parser built from S3 fixtures: unescape `%output` octal bytes, pair `%begin/%end` command replies, dispatch `%`-notifications. `bridge.ts` owns the `tmux -CC attach` child (`Bun.spawn`, piped stdio), enumerates via `list-sessions -F`, emits per-session `SESSION_STATE` + a `SESSION_LIST` boundary, maps `%output` -> chunked `TERMINAL_DATA` (reuse the `splitOutputText` split discipline against `MAX_SECURE_PLAINTEXT`), and on device attach seeds the pane via `capture-pane -e -p` (KTD3). `KEYSTROKE` frames route to `send-keys -H`. Wire into `app.ts` where the registry sink binds; `bin/host.ts` gains a tmux mode (e.g. `SENDAI_TMUX=1` / target session) replacing the `SENDAI_AGENT` spawn block. Keep the single-sink "last ATTACH wins" model (single-device scope). Surface attach failures ($TMUX/socket/env differences — see learnings) as a device-visible ERROR, not a hang.
**Execution note:** Build the control-mode parser test-first against the captured fixtures before wiring the live child.
**Patterns to follow:** `adapters/subprocess.ts` (child spawn shape, but byte/notification framing not JSONL); `registry` sessionId multiplexing; explicit `Uint8Array` typing on byte buffers (learnings).
**Test scenarios:**
- Parser: `%output` with octal escapes decodes to exact bytes; `%begin/%end` pairs a command reply; unknown `%`-lines are ignored, not fatal.
- Enumerate: three tmux sessions produce three `SESSION_STATE` frames with correct names/ids. Covers AE5.
- Stream: a pane write becomes one or more `TERMINAL_DATA` frames whose concatenated hex decodes to the original bytes; a >16KB burst splits across frames.
- Keys: a `KEYSTROKE` frame results in a `send-keys` for the correct pane. Covers AE6.
- Resync: on a fresh attach the device first receives the captured current-screen contents, then live output. Covers AE7.
- Failure: attaching to a non-existent/again-detached session yields a device ERROR frame, no hang.
**Verification:** `bun test host/` green including new suites; a manual run against a real `tmux new -s` streams to a mock device.

### U32. Alert detection (host side)

**Goal:** Turn control-mode signals into `ALERT_SIGNAL` frames with a small, tunable taxonomy and few false positives.
**Requirements:** R40.
**Dependencies:** U31.
**Files:** `host/src/tmux/bridge.ts` (extend), `host/test/tmux-bridge.test.ts` (extend), optionally `config/` for thresholds.
**Approach:** Map `%bell` -> `attention`; pane-dead/`%exit` -> `session_ended`; and a best-effort `likely_done` when a session goes from active to idle for a tunable interval. Require `monitor-bell`/`monitor-activity` semantics as available; document that `likely_done` is heuristic. Emit per-session so the device can badge the right tile.
**Test scenarios:**
- A `%bell` in the fixture stream emits one `attention` alert for that session.
- A pane-death notification emits `session_ended`.
- Routine `%output` emits no alert.
- Idle-after-activity past the threshold emits exactly one `likely_done` (not repeated each tick).
**Verification:** `bun test host/test/tmux-bridge.test.ts` green.

### Phase 3 — Device terminal mode

### U33. Device terminal emulator (render + scrollback)

**Goal:** Render the focused session's live terminal on the top screen from `TERMINAL_DATA`, with scrollback, keyed by session id.
**Requirements:** R29, R37.
**Dependencies:** S4, U30, U31.
**Files:** `client/source/term.c`, `client/source/term.h`, `client/source/termfont.c`, `client/source/termfont.h`, `client/source/main.c` (dispatch `TERMINAL_DATA` by `session_id`), `client/source/ui.c`/`ui.h` (host the grid on the top screen), `client/test/term_test.c`.
**Approach:** A cell grid (char + SGR attr) sized to the S4-chosen columns/rows, a minimal ANSI/SGR state machine (printable, CSI cursor moves, SGR colors, line wrap, CR/LF, backspace, tab), a scrollback ring, and a citro2d glyph-atlas renderer with the bundled monospace font (dirty-rect per S4). Replace the flat `ui_state.output[1024]` with per-session grid+scrollback state, dispatched on `f->session_id`. Alt-screen sequences (KTD2) may be ignored or best-effort. The parser core (`term.c`) is pure C, host-compilable for the KAT.
**Execution note:** Write `term_test.c` (host-compiled ANSI cases) before/alongside the renderer; keep the parser free of libctru so it host-compiles.
**Patterns to follow:** DSSH's parser scope (S4 findings); the pure-core-plus-KAT split already used for `crypto.c`/`frame_test.c`; `client/test/run.sh` `EXTRA_SRC` to pull `term.c` into the harness.
**Test scenarios (host-compiled parser KAT):**
- Printable text fills cells left-to-right; wrap at the last column moves to a new row.
- `CSI H`/`CSI <r>;<c>H` positions the cursor; `CSI K` clears to line end.
- SGR: `\e[31m`/`\e[0m` sets and resets a cell's color attribute.
- CR/LF/backspace/tab advance the cursor correctly; scrollback captures lines pushed off the top.
- A malformed/incomplete escape doesn't corrupt the grid or crash (partial sequence buffered).
- `Test expectation: rendering itself is verified on hardware (runtime-unverified per repo convention); the parser is covered by the KAT.`
**Verification:** `client/test/run.sh` green with `term_test.c`; devkitARM build clean; on-hardware, a streamed session is readable and scrollback holds.

### U34. Device input: keystrokes, keyboard, physical scroll

**Goal:** Send real keystrokes to the session and navigate the terminal with physical buttons.
**Requirements:** R30, R31, R33.
**Dependencies:** U33.
**Files:** `client/source/main.c` (input loop), `client/source/net.c`/`net.h` (a `ab_net_send_keys` helper), `client/source/term.c`/`term.h` (scroll API).
**Approach:** Map printable input and control keys to `KEYSTROKE` frames (hex key bytes): Enter=`\r`, Ctrl-C=`\x03`, Esc=`\x1b`, Tab=`\t`, arrows=CSI sequences. swkbd opens on the keyboard control-strip button (U35) or a text-target tap, and its committed text is sent as `KEYSTROKE`. D-pad/L-R scroll and page the scrollback via the `term.c` scroll API without sending input. Remote echo only (KTD: DSSH model — no local echo buffer).
**Patterns to follow:** existing `send_prompt_via_keyboard` swkbd usage in `main.c`; `ab_net_send` framing.
**Test scenarios:**
- Pressing the mapped Ctrl-C control emits a `KEYSTROKE` frame carrying `0x03` for the focused session. Covers AE6.
- Arrow inputs emit the correct CSI byte sequences.
- swkbd-committed text emits a `KEYSTROKE` frame with the exact UTF-8 bytes (hex).
- D-pad scroll changes the visible scrollback window and sends nothing on the wire.
- `Test expectation: input wiring is runtime-unverified on hardware per repo convention; the frame-construction helper is unit-testable where pure.`
**Verification:** devkitARM build clean; on-hardware, typing and Ctrl-C reach the desk session (AE6).

### U35. Bottom screen: control strip, session picker, mode toggle

**Goal:** The bottom screen carries the terminal-mode control strip, a session picker, and the toggle to macropad mode — all via touch.
**Requirements:** R32, R34, R37.
**Dependencies:** U33, U34.
**Files:** `client/source/ui.c`/`ui.h` (bottom-screen renderers + hit-testing), `client/source/main.c` (touch handling, mode state), `client/source/json.c`/`json.h` (parse repeated `SESSION_STATE` into a session list — no array parser needed per KTD5).
**Approach:** Add `hidTouchRead` handling and hand-rolled hit-testing over drawn buttons. Terminal-mode strip: Ctrl, Esc, Tab, arrows, Ctrl-C, keyboard (each tap -> the U34 keystroke path; Ctrl is a sticky modifier for the next key). Session picker: render one row per `SESSION_STATE`, tap sends `FOCUS_SESSION`. A mode-toggle control swaps the bottom screen between terminal strip and macropad grid (U36). Keep per-session state so switching focus repaints the right grid.
**Patterns to follow:** citro2d immediate-mode draw in `ui.c`; `FOCUS_SESSION` already exists in the protocol and registry routing.
**Test scenarios:**
- Tapping a control-strip key triggers the corresponding `KEYSTROKE`; Ctrl then C yields `0x03`.
- Two `SESSION_STATE` frames render two picker rows; tapping the second emits `FOCUS_SESSION` for its id, and subsequent `TERMINAL_DATA` for that id repaints the top screen. Covers AE5.
- The mode toggle swaps bottom-screen renderers and back without losing terminal state.
- `Test expectation: touch/render runtime-unverified on hardware; JSON parse of repeated SESSION_STATE is unit-testable in the host-compiled harness if json.c is included.`
**Verification:** devkitARM build clean; on-hardware, control keys and session switching work by touch.

### Phase 4 — Macropad and alerts

### U36. Macropad mode: layout + keystroke actions

**Goal:** A toggleable grid of configurable quick-action buttons that fire keystrokes/strings into the focused session.
**Requirements:** R34, R35, R36.
**Dependencies:** U30, U35.
**Files:** `host/src/tmux/keymap.ts` (intent->keystroke resolution), `host/src/macropad/layout.ts` (reuse; emit `MACROPAD_LAYOUT`), `host/src/layouts/load.ts` (reuse `.pad`), `client/source/ui.c` (macropad grid render + hit-test), `client/source/main.c` (button -> `KEYSTROKE`), `host/test/keymap.test.ts`, `layouts/example.pad` (extend with keystroke intents).
**Approach:** Reuse the `.pad` format and the `MACROPAD_LAYOUT` frame; the host pushes a layout for terminal mode. New `keymap.ts` resolves a button intent to keystroke bytes (approve=`y\r`, deny=`n\r`, interrupt=`\x03`, custom string) — replacing `intent.ts`'s prompt table for this path (KTD7). Device renders the grid, and a tap sends a `KEYSTROKE` frame (the button may carry the literal bytes, or an intent the host maps — decide in favor of device-sends-literal to keep the host stateless per button; the `.pad` then defines the literal/keystroke).
**Patterns to follow:** `layouts/load.ts` `.pad` parse; `macropad/layout.ts` producer; `MACROPAD_LAYOUT`/`MacropadButton` payloads in `messages.ts`.
**Test scenarios:**
- `keymap.ts`: intent `approve` resolves to `y\r`; `interrupt` to `\x03`; an unknown intent is rejected/no-op (fail-safe).
- A `.pad` with three buttons produces a `MACROPAD_LAYOUT` with three buttons.
- Device: tapping the "approve" macropad button emits the configured `KEYSTROKE`. Covers AE8.
- Mode toggle returns to the live terminal view. Covers AE8.
**Verification:** `bun test host/test/keymap.test.ts` green; devkitARM build clean; on-hardware AE8.

### U37. Device alerts + lid-closed survival

**Goal:** Play a sound and drive the hinge LED on `ALERT_SIGNAL`, working with the lid closed.
**Requirements:** R38, R39, R40.
**Dependencies:** U30.
**Files:** `client/source/alert.c`, `client/source/alert.h`, `client/source/main.c` (init + `ALERT_SIGNAL` handling + `aptSetSleepAllowed(false)`).
**Approach:** `alert.c` wraps `ndsp` (short notification tone; guard on missing `sdmc:/3ds/dspfirm.cdc` — degrade to LED-only) and `mcuHwc` raw IPC for the notification LED (per-class pattern/color). Call `aptSetSleepAllowed(false)` at startup so CPU/DSP/services stay alive with the lid shut (KTD6); add the NDM WiFi lock if required to keep the socket alive through sleep. Map `ALERT_SIGNAL.class` to LED pattern (+ sound if available). No alert on routine data.
**Execution note:** Build against the real toolchain immediately; `ndsp`/`mcuHwc` are in `-lctru` but each needs its own `#include` (learnings: headers aren't transitive).
**Patterns to follow:** libctru `ndsp` example init; 3dbrew MCUHWC command shape; the "COMPILES; runtime UNVERIFIED" header caveat.
**Test scenarios:**
- `ALERT_SIGNAL{attention}` lights the configured LED pattern; `session_ended` a different one.
- With `dspfirm.cdc` absent, the device raises the LED and skips sound without crashing.
- Routine `TERMINAL_DATA` raises no alert.
- `Test expectation: audio/LED/lid behavior is runtime-unverified without hardware per repo convention; verified by build + on-hardware check.`
**Verification:** devkitARM build clean; on-hardware with the lid closed, a tmux bell lights the LED (AE9) and, where `dspfirm` is present, plays a sound.

### Phase 5 — Integration

### U38. End-to-end + docs

**Goal:** Prove the whole loop and update the docs/tracker to the new product shape.
**Requirements:** R25-R41 (integration); AE5-AE9.
**Dependencies:** U31-U37.
**Files:** `host/test/e2e-tmux.test.ts`, `README.md`, `CONCEPTS.md`, `docs/PROTOCOL.md`, `docs/plans/2026-07-01-001-...-plan.md` (mark the terminal pivot; note the structured stack is now off-path), `client/README.md`.
**Approach:** An e2e test with a mock device (or a real `tmux`) driving a session through the encrypted transport: attach -> receive session list + seeded screen -> `KEYSTROKE` runs a command -> `TERMINAL_DATA` streams the output -> a bell yields `ALERT_SIGNAL`. Assert no plaintext crosses the wire (reuse the AE4 no-cleartext check). Update README to the terminal+macropad framing, document the tmux mode env vars and the `dspfirm.cdc`/LED-first alert caveat, extend `docs/PROTOCOL.md` with the new frames, and record in the v1 plan/tracker that terminal mode is primary and the structured stack is retained-but-off-path.
**Test scenarios:**
- Full loop: attach, session list, seeded screen, keystroke-drives-command, streamed output, bell->alert — all sealed.
- AE4-style: raw captured wire bytes contain no readable pane text or keystrokes (encryption holds for terminal data too).
- Regression: existing `bun test` suite stays green with the tmux path added.
**Verification:** `bun test` green; `tsc --noEmit` clean; devkitARM build clean; docs updated and accurate.

---

## Requirements Traceability

| Requirement | Units |
|---|---|
| R25 unmodified tmux create | U31 |
| R26 enumerate sessions | S3, U31 |
| R27 bidirectional bridge | S3, U31 |
| R28 reconnect/resync to tmux | U31 |
| R29 device terminal render | S4, U33 |
| R30 send keystrokes incl. control | U34 |
| R31 physical scroll/navigate | U34 |
| R32 control strip | U35 |
| R33 on-demand keyboard | U34, U35 |
| R34 mode toggle | U35, U36 |
| R35 macropad buttons | U36 |
| R36 configurable button sets | U36 |
| R37 session list + switch | U31, U35 |
| R38 sound alerts | U37 |
| R39 hinge LED + lid-closed | U37 |
| R40 host alert detection | U32, U37 |
| R41 encrypted transport reuse | U30, U31 |

## Scope Boundaries

**In scope:** tmux control-mode bridge (host as client, no pty); per-session `SESSION_STATE` enumeration; chunked hex `TERMINAL_DATA` streaming; `KEYSTROKE` injection via `send-keys`; capture-pane resync on attach; a device scrolling-terminal renderer (minimal ANSI/SGR) with scrollback; touch control strip + physical scroll + on-demand swkbd; session picker + focus switch; macropad mode with `.pad` keystroke actions; sound + hinge-LED alerts with lid-closed survival; the three new sealed frame types; e2e + docs.

**Deferred for later** (carried from origin):
- Structured mode (parse claude/codex stream-json for a HUD + host-mediated approvals). The v1 adapter/registry/policy/capability stack is retained but off-path.
- Voice / push-to-talk (separate track).
- Full alt-screen TUI fidelity (mouse reporting, truecolor, image protocols) — beyond the log-scroll target of KTD2.
- Multi-user / multiple concurrent 3DS clients (single-sink model).

**Deferred to Follow-Up Work** (plan-local sequencing):
- A raw-binary `TERMINAL_DATA` frame variant bypassing canonical JSON — build only if S3/E2E shows hex-in-JSON throughput is inadequate (see Open Questions).
- A real C JSON array parser for `SESSION_LIST` — only if per-session `SESSION_STATE` proves insufficient.
- A `libvterm` port — only if the hand-rolled parser proves too limited.

**Outside this product's identity** (carried from origin): running the agent/tmux on the 3DS; a full IDE/editor on-device; replacing the desktop terminal. The v1 "not a terminal" boundary is explicitly retired.

## Risks & Mitigations

- **Device terminal legibility/perf at 400x240 (highest).** Mitigation: S4 on-hardware spike first; scope to log-scroll (KTD2); glyph atlas + dirty-rect; alt-screen apps documented as out-of-scope.
- **tmux control-mode parser edge cases** (`%output` escaping, `%begin/%end`, layout/session churn). Mitigation: build from captured fixtures (S3), unit-tested (U31), unknown lines non-fatal.
- **Throughput of hex-inflated terminal data over AEAD + 802.11.** Mitigation: S3 measures it; raw-binary frame escape hatch held ready (KTD4).
- **`dspfirm.cdc` absent -> no audio.** Mitigation: LED is the guaranteed channel; sound degrades gracefully (KTD6, U37).
- **Lid-closed survival unproven** (no NDM/sleep code today). Mitigation: `aptSetSleepAllowed(false)` + NDM lock built and hardware-checked in U37; the origin's "already held" claim is corrected.
- **Spawned tmux client env differs from interactive shell** ($TMUX/socket). Mitigation: surface attach failures as device ERROR, not a hang (learnings; U31).

## Dependencies / Assumptions

- The user runs tmux on the host (Mac or VPS); non-tmux shells are out of scope for the primary flow.
- `tmux -CC` control mode is available (tmux 3.x) and drivable over `Bun.spawn` pipes — no `node-pty` (Bun-incompatible) and no pty needed.
- `ndsp` and `mcuHwc` are in `-lctru` (no Makefile lib change); `ndsp` needs `sdmc:/3ds/dspfirm.cdc` at runtime.
- Client C remains verified by build + host-compiled KAT; render/audio/LED/touch are hardware-gated per repo convention.
- The encrypted transport + discovery from plan 002 are reused unchanged.
- Plan/U-ID/S-ID sequence: this is plan 003; new units U30-U38; new spikes S3-S4 (never-renumber discipline).

## Open Questions

**Deferred to implementation / spike**
- `TERMINAL_DATA` encoding: hex-in-JSON (default) vs a raw-binary frame variant — decided by S3/E2E throughput measurement.
- Exact terminal column/row count, font, and redraw strategy — set by S4.
- Alert `likely_done` heuristic threshold and whether it causes false positives in practice — tuned in U32.
- Whether the NDM WiFi lock is needed (in addition to `aptSetSleepAllowed(false)`) to keep the TCP socket alive through lid-close — determined on hardware in U37.
- Macropad button model: device-sends-literal-bytes (stateless host) vs host-maps-intent — leaning literal; confirm in U36.

## Sources / Research

- Origin requirements: `docs/brainstorms/2026-07-01-3ds-tmux-terminal-macropad-requirements.md`.
- tmux control mode (`tmux -CC`): tmux.1 CONTROL MODE, iTerm2 tmux integration docs — pipe-based protocol, `%output` octal-escaped bytes, `send-keys` input, `list-sessions -F` enumeration, `%bell`/pane-death notifications. No maintained Bun/Node control-mode library — custom parser.
- Bun: no native pty API; `node-pty` has unresolved Bun compatibility — control mode needs neither.
- Device terminal: Fishason/DSSH (feasibility proof for a hand-rolled VT parser + citro2d render at 400x240; log-oriented, not full alt-screen).
- libctru/3dbrew: `ndsp` audio (needs `dspfirm.cdc`), `mcuHwc` notification LED (raw IPC, no libctru wrapper), `aptSetSleepAllowed(false)` for lid-closed survival, `hidTouchRead` for touch — all confirmed in `-lctru`.
- Institutional learnings: `docs/solutions/build-errors/devkitpro-3ds-homebrew-cross-compile.md` (LD/ARCH, explicit service headers, build-early), `docs/solutions/architecture-patterns/driving-coding-agent-clis-from-a-host.md` (single-source codegen + golden vectors; build parsers from captured output; subprocess env differs), `docs/solutions/developer-experience/bun-and-workflow-tooling-gotchas.md` (explicit `Uint8Array` typing).
- Repo surfaces: `protocol/codegen/message-types.source.ts` (next down 11 / up 72), `host/src/{app,registry,adapters/subprocess}.ts`, `host/bin/host.ts`, `client/source/{main,ui,net,json}.c`, `client/Makefile`, `layouts/*.pad` + `host/src/layouts/{load,intent}.ts` (reusable macropad plumbing).
