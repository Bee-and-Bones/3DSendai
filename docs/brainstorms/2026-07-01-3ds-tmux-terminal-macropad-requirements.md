---
date: 2026-07-01
topic: 3ds-tmux-terminal-macropad
---

# 3DS as a Remote tmux Terminal + Macropad — Requirements

## Summary

Turn the 3DS into a **remote terminal for your own tmux sessions**, plus a **desk macropad**. You start a session the normal way (`tmux new -s myproject`) in your terminal on your Mac or a VPS. 3dsendai's host bridges that tmux session to the 3DS over the encrypted transport already built; you open the homebrew app, pick the session up by name, and drive it fully — the top screen renders the live terminal, the bottom screen is a control strip, and the physical buttons scroll and navigate. A second, toggleable mode turns the 3DS into a Stream-Deck-style macropad: quick-action buttons that fire keystrokes (approve, reject, common commands) into the session you're already watching on your monitor.

## Problem Frame

The v1 product treated the 3DS as a *structured controller* that drives host-spawned headless agents and deliberately avoids being a terminal (DSSH's lane). Building against real use, the owner wants something more direct and more tmux-shaped: keep the existing terminal workflow untouched, and make the 3DS a way to *pick up and drive that exact session* from the couch — and, when back at the desk, a physical quick-action pad for the run already on screen.

This is a **deliberate identity shift**, recorded as a decision below: 3dsendai becomes an *encrypted, zero-config remote terminal + macropad for tmux sessions*, not a structured non-terminal controller. The differentiator is no longer "avoids being a terminal" — it's everything wrapped around the terminal: encrypted pickup, zero-config discovery, tmux-native persistence, the macropad mode, and lid-closed attention alerts on a device you already own.

The encrypted transport and zero-config discovery shipped in the prior milestone carry this unchanged — they move opaque frames and don't care whether the payload is a structured event or a raw terminal chunk.

## Key Decisions

- **Leverage the user's own tmux; don't manage our own.** The user runs `tmux new -s <name>` (and detach/reattach) exactly as they do today. 3dsendai discovers and attaches to the *existing* tmux server as a client. tmux owns persistence, session naming, scrollback, and survival across disconnects — 3dsendai inherits all of it for free and adds no new persistence layer.
- **The host is a tmux client, via control mode.** The robust, structured way to bridge tmux programmatically is tmux **control mode** (`tmux -CC` / `control-mode`) — the same protocol iTerm2 uses. It streams pane content and notifications and accepts input, which is far more reliable than `capture-pane` scraping or blind `send-keys`. Exact mechanism (control mode vs. a dedicated `pipe-pane` + `send-keys` fallback) is a planning-time spike; the product decision is "be a real tmux client, not a screen-scraper."
- **Raw terminal, not structured agent events, is the primary path.** In terminal mode the 3DS renders actual terminal output and sends actual keystrokes. The host does not parse claude/codex stream-json here — whatever runs inside the tmux pane (an agent, a shell, `top`, anything) just works. This demotes the existing structured-adapter stack (per-agent normalizers, approval-policy engine, capability negotiation) from primary path to a possible future "structured mode," out of scope here.
- **Two modes, toggleable on the device: Terminal and Macropad.** Terminal mode is the remote-drive experience. Macropad mode turns the bottom screen into configurable quick-action buttons for the focused session — usable from the couch or, more to the point, at the desk while watching the run on the monitor.
- **Input model: control strip + physical navigation + on-demand keyboard.** The bottom screen carries a persistent strip of tappable control keys (Ctrl, Esc, Tab, arrows, Ctrl-C) plus a keyboard button. Physical 3DS buttons scroll and navigate the terminal. The system software keyboard opens on demand — when the user taps the keyboard button, or when they tap into something that obviously wants free text.
- **Alerts are first-class and lid-aware.** The speaker and the hinge notification LED signal attention events (a tmux bell, an approval prompt, activity-then-idle = likely done, a session dying) — and must fire with the lid closed, building on the NDM WiFi lock already held through sleep.
- **Multiple sessions, listed and switchable.** tmux already hosts many named sessions; the 3DS lists them and switches focus between them. This subsumes the original "multi-agent board" ask — the board is now a tmux session list.

## Actors

- A1. **Developer** — starts tmux sessions normally at the desk; picks them up and drives them from the 3DS; uses the macropad at the desk. The sole human user.
- A2. **3DS client** (`.3dsx`, C/libctru) — now a terminal emulator + control strip + macropad + alerter. Renders terminal output, sends keystrokes, plays sounds, drives the LED.
- A3. **Host** (Bun/TS) — a tmux **client** bridging tmux sessions to AgentBus over the encrypted transport; enumerates sessions, streams pane output down, sends keystrokes up, and watches for alert-worthy events.
- A5. **tmux server** (user-owned, on the Mac or VPS) — the real persistence and session-management layer. 3dsendai attaches to it; it is not spawned or managed by 3dsendai.

(A4, the host-parsed agent CLIs from v1, are no longer a distinct actor in this mode — agents run *inside* the tmux pane and are opaque to the host.)

## Requirements

**Session model & tmux bridge**

- R25. The user starts and manages sessions with unmodified tmux (`tmux new -s <name>`, detach, reattach). 3dsendai requires no change to how sessions are created.
- R26. The host attaches to the existing tmux server as a client and enumerates its sessions (name, and enough state to show activity), exposing them to the device as a selectable list.
- R27. The host bridges a focused tmux session bidirectionally: pane output streams to the device; device keystrokes are delivered to the pane. The bridge is structured (control mode preferred) rather than screen-scraping, and survives the user detaching/reattaching their own tmux clients.
- R28. Reconnect and replay: after a WiFi drop or lid-close, the device reattaches and restores the current terminal view (tmux holds the authoritative buffer; the device resyncs to it) without the user losing place.

**Terminal mode (device)**

- R29. The top screen renders live terminal output with enough VT/ANSI fidelity to use a coding agent's TUI and common shell tools (cursor positioning, colors, line wrapping, redraws). Fidelity target and scrollback depth are an open question (see below); DSSH is the reference that this is feasible on 3DS hardware.
- R30. The device sends real keystrokes to the session, including printable text and the control keys terminal work requires (Ctrl-C, Esc, Tab, arrows, Enter).
- R31. Physical 3DS buttons scroll and navigate the rendered terminal (scrollback, page up/down) without sending input to the session.

**Input & keyboard**

- R32. The bottom screen (in terminal mode) shows a persistent control strip: Ctrl, Esc, Tab, arrow keys, Ctrl-C, and a keyboard button, each one tap.
- R33. The software keyboard opens on demand — on the keyboard button, or when the user taps a target that obviously expects free text — and its committed text is sent to the session.

**Macropad mode**

- R34. A device toggle switches between terminal mode and macropad mode for the focused session.
- R35. In macropad mode the bottom screen is a grid of quick-action buttons; each button fires a predefined keystroke or string into the focused session (e.g. approve, reject, a common command).
- R36. Macropad button sets are configurable (not hardcoded), reusing the existing `.pad`-style host-defined layout concept, and bound to the keystrokes/strings they send.

**Multi-session**

- R37. The device lists available tmux sessions and lets the user switch the focused session; terminal output, control strip, and macropad all follow the focused session.

**Attention & alerts**

- R38. The device plays a notification sound (speaker) for attention events, distinguishable per event class where it adds value.
- R39. The device drives the hinge notification LED for attention events, and alerts (LED at minimum) fire with the lid closed.
- R40. The host detects attention-worthy events from the session stream — at minimum the terminal bell — and signals the device which alert to raise. Additional triggers (an approval-style prompt, activity-then-idle, a pane/session dying) are desirable where reliably detectable.

**Transport & security (reuse)**

- R41. All of the above rides the existing encrypted transport (XChaCha20-Poly1305 PSK) and zero-config discovery. Terminal bytes and keystrokes are as protected as the rest of AgentBus; no new plaintext path.

## Key Flows

- F5. **Pick up a session.** Developer has `tmux new -s api` running at the desk. They open 3dsendai on the 3DS; it discovers the host, lists tmux sessions, and they pick `api`. The top screen fills with the live terminal. **Covers R25, R26, R28, R37.**
- F6. **Drive it remotely.** From the couch, the developer scrolls the buffer with the D-pad, taps Ctrl then C to interrupt a run, taps the keyboard button, types a prompt, and sends it. Output streams back live. **Covers R27, R29, R30, R31, R32, R33.**
- F7. **Desk macropad.** Back at the desk watching the run on the monitor, the developer toggles the 3DS to macropad mode and taps "approve" to clear a pending prompt without reaching for the keyboard. **Covers R34, R35, R36.**
- F8. **Switch sessions.** Several tmux sessions run (`api`, `web`, `infra`). One hits a bell while a different one is focused. The developer opens the session list, sees which needs attention, and switches to it. **Covers R37, R40.**
- F9. **Lid-closed attention.** The lid is shut while an agent works. The session emits a bell (or the host detects a prompt). The hinge LED lights and a sound plays; the developer flips the lid open to the session already waiting. **Covers R38, R39, R40.**

## Acceptance Examples

- AE5. **Covers R25, R26.** With `tmux new -s api` already running and never touched by 3dsendai, the 3DS lists a session named `api` and opening it shows that session's live pane — proving 3dsendai attached to the user's own tmux rather than spawning its own.
- AE6. **Covers R27, R30.** A keystroke sent from the 3DS (e.g. Ctrl-C) takes effect in the same tmux session the user also has attached at the desk, and both the desk client and the 3DS see the result — one shared session, two live clients.
- AE7. **Covers R28.** The lid closes for two minutes mid-run; on reopen the device resyncs to tmux's current buffer and the developer continues, with no lost session and no stale frozen screen.
- AE8. **Covers R34, R35.** Toggling to macropad mode and tapping "approve" delivers the configured keystrokes to the focused session; toggling back returns to the live terminal view.
- AE9. **Covers R39, R40.** With the lid closed, a tmux bell in the focused session lights the hinge LED (and plays a sound if the speaker is reachable while closed), and no alert fires for routine non-bell output.

## Success Criteria

- **Pickup works:** a session created with plain `tmux new -s` appears on the 3DS and renders live, with zero changes to how the user starts tmux.
- **Drive works:** the developer can run and interrupt a coding-agent turn end-to-end from the 3DS — read the TUI, send text, send Ctrl-C — over the encrypted link, on real hardware.
- **Macropad works:** a configured quick-action button reliably fires its keystrokes into the focused session, and the mode toggle is obvious.
- **Alerts work lid-closed:** a bell (or detected prompt) reaches the developer via LED/sound with the lid shut, and routine output does not cry wolf.

## Scope Boundaries

**Deferred for later**
- Structured mode (parse claude/codex stream-json for a clean HUD + real approval-policy routing). The v1 adapter/registry/policy stack is retained in the codebase for this future mode but is not the path here.
- Voice / push-to-talk (separate track; unchanged by this brainstorm).
- Rich terminal features beyond agent/shell use — mouse reporting, full 256-color/truecolor fidelity, image protocols — pursued only if they prove necessary in practice.
- Multi-user / multiple simultaneous 3DS clients on one host.

**Outside this product's identity**
- Running the agent (or tmux) *on* the 3DS — the host and the desk machine always own the compute.
- Being a full IDE or editor on-device.
- Replacing the desktop terminal — the 3DS is a mobile pickup + a desk macropad for a session that lives in the user's own tmux, not the primary place work happens.
- **Retired boundary:** the v1 rule "a terminal on the 3DS is DSSH's lane; we are not a terminal" is explicitly reversed by the identity decision above. Being a terminal is now the point; the moat is the encrypted/zero-config/tmux-native/macropad/alert wrapper around it.

## Dependencies / Assumptions

- The user runs tmux on the host (Mac or VPS) and is comfortable with `tmux new -s`/attach/detach. Non-tmux shells are out of scope for the primary flow.
- tmux control mode (or an equivalent structured client path) can deliver pane output and accept input reliably enough to render an agent TUI — **to be validated by a planning-time spike** before committing to it; `capture-pane` + `send-keys` is the fallback, with lower fidelity.
- The 3DS can render a usable terminal at 320x240 with the system or a bundled font — **assumed feasible on the strength of DSSH; legibility and required VT fidelity are unverified and need an early hardware check.**
- The hinge notification LED is drivable from homebrew via MCU services and can be lit with the lid closed; the speaker's reachability while closed is **unverified** and may make LED the only guaranteed lid-closed channel.
- The existing NDM WiFi lock keeps the network alive through lid-close (already in place).
- The encrypted transport and discovery from the prior milestone are reused as-is.

## Outstanding Questions

**Deferred to planning**
- tmux bridge mechanism: control mode vs. `pipe-pane`+`send-keys` fallback; how session enumeration and per-session activity/bell state are read.
- Terminal emulator scope on-device: which VT/ANSI subset, scrollback depth, wrapping/resize behavior, and how the 3DS reports its terminal size to tmux.
- Keystroke encoding on the wire: how printable text and control/modifier keys are represented in new protocol frames, and local-echo vs. remote-echo/latency feel over WiFi.
- Alert taxonomy: which events map to which sound/LED pattern, and how "activity-then-idle = done" and "approval prompt" are detected without false positives in raw output.
- Macropad configuration: where button sets live, per-session vs. global, and how they are authored/edited.
- New AgentBus message types for terminal data, keystrokes, session list/switch, and alert signals — routed through the single-source codegen + golden-vector discipline.

## Sources / Research

- Prior product doc (the structured-controller model this pivoted away from): removed in the docs cleanup; see git history.
- Shipped transport this reuses: [docs/PROTOCOL.md](docs/PROTOCOL.md), [docs/plans/2026-07-01-002-feat-encrypted-transport-discovery-plan.md](docs/plans/2026-07-01-002-feat-encrypted-transport-discovery-plan.md).
- Repo surface (session registry, SESSION_LIST/FOCUS_SESSION, single-session device UI, no audio/LED/touch/array-JSON today) and CLI-adapter learnings gathered this session; device terminal feasibility grounded on Fishason/DSSH.
- Reference prior art: [DSSH](https://github.com/Fishason/DSSH) (SSH terminal on 3DS — feasibility proof for on-device terminal rendering), tmux control mode (`tmux -CC`, as used by iTerm2).
