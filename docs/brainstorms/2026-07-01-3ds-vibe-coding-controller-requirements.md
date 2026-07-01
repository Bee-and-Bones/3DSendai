---
date: 2026-07-01
topic: 3ds-vibe-coding-controller
---

# 3DS Vibe-Coding Controller — Requirements

## Summary

A Bun/TypeScript host plus a 3DS homebrew client that turns a Nintendo 3DS into a controller for several coding agents at once — a tile board of live agent sessions driven by push-to-talk voice and a context-aware touch macropad, with physical approve/deny on the face buttons. The host compiles to a single binary and deploys to a laptop, Pi, or VPS, so the 3DS works as a standalone remote coding device.

## Problem Frame

Driving a coding agent today means sitting at a terminal. The reference project [rAI3DS](https://github.com/just1jray/rAI3DS) proved a 3DS can be a companion controller, but it drives Claude Code by injecting `tmux` keystrokes and regex-scraping the pane — an approach its own commit history shows was reworked repeatedly because no variant was reliable. That mechanism is also why it's Claude-Code-only and LAN-plaintext-only.

Two things make a generalized version worth building now. First, the scarce resource in 2026 agent work is *attention across many long-running agents*, not typing — and alt-tabbing terminals is a poor tool for "which of my agents needs me right now." Second, agent CLIs have converged on machine-readable headless surfaces (stream-json, JSON-RPC, HTTP+SSE), so a clean protocol can replace keystroke injection entirely. The bet is a purpose-built controller that leans into what the 3DS is good at — physical buttons, a mic, two screens — and away from what it's bad at (rendering a terminal), reachable from anywhere its host is deployed.

## Key Decisions

- **Orchestration board, not single-session.** v1's identity is conducting N agents at once (one tile per session), not one 3DS bound to one terminal. This is also the product's answer to "why not just SSH": SSH gives one terminal; this gives a glanceable multi-agent board.
- **AgentBus protocol as the spine.** One versioned wire protocol carries state/output down and semantic input up. The device never speaks any agent's native protocol; the host owns per-agent adapters. Adding an agent is a host change, never a firmware change.
- **Bun/TypeScript host.** Chosen over Rust/Go because the hard, correctness-sensitive work is the adapters and the approval flow, and TS has the official Claude Agent SDK (native `canUseTool` approvals + streaming). Perf/concurrency is not the constraint at this scale; the bottlenecks are 802.11g WiFi and whisper STT. `bun build --compile` still yields a single deploy binary.
- **Homebrew-only client with full voice.** Voice needs raw mic + sockets the stock-3DS browser can't provide, so v1 is a `.3dsx` homebrew client. It runs on stock consoles via a per-boot exploit (no permanent CFW required). A no-mod browser tier is deferred.
- **Deployable host, durable session.** The host owns the session and its output buffer; the 3DS is a reconnectable thin client. This is what makes VPS-hosting and lid-close survival work.
- **Security is a v1 requirement — but authentication and encryption split.** The host executes agent tool calls, so *authentication* is not deferrable: a device token gates every connection from M1 (host binds loopback by default, refuses a non-loopback bind without a token). Otherwise any same-LAN device could drive the host and self-approve its tool calls. *Encryption* is the deferrable half — TLS on the 3DS is a known homebrew pain point (`sslc` is limited; realistic paths are an mbedTLS port or an encrypted tunnel), so transport encryption lands at M4 when the host goes remote.
- **Single framed TCP transport.** One length-prefixed, versioned TCP connection carries control, state, output, and chunked audio. Simplest client and a single TLS session for remote use. Splitting audio onto a separate UDP channel is a deferred escape hatch, taken only if the M3 hardware test shows voice partials feel laggy under real WiFi.
- **C/libctru client.** The client is built in C on libctru — the toolchain that guarantees the two make-or-break capabilities (raw mic PCM capture, low-level sockets) and has reusable reference code (CTurt/3DSController, rAI3DS, DSSH). The client stays thin, so C's overhead is bounded; the fast-iteration complexity lives in the TS host.
- **Spine-first build order.** All six ideation survivors stay in the plan, sequenced: a walking skeleton retires the core risk before board, voice, more agents, and VPS layer on.

## Actors

- A1. **Developer** — drives agents from the 3DS; the sole human user in v1.
- A2. **3DS client** (`.3dsx`, C/libctru) — thin I/O surface: mic, touch, face/shoulder buttons, two screens. No agent logic.
- A3. **Host** (Bun/TS) — session registry, agent adapters, STT, approval routing, security/pairing.
- A4. **Agent CLIs** — Claude Code and Codex in v1, each run under a host adapter; more agents slot in via the same interface.

## Requirements

**Transport & protocol (AgentBus)**

- R1. Define one versioned wire protocol: state and output frames flow to the device, semantic input events flow up. The device never emits an agent's native keystrokes or protocol.
- R2. The protocol is client-agnostic (a future non-3DS client speaks the same protocol) and agent-agnostic (a new agent is added as a host adapter with no device change).
- R3. The device↔host link is a single framed TCP connection carrying control, state, output, and chunked audio; framing is length-prefixed and versioned. A separate loss-tolerant UDP audio channel is a deferred escape hatch, added only if voice partials prove laggy under real WiFi (see M3).

**Host & sessions**

- R4. The host is a single deployable artifact runnable on a laptop, Pi, or VPS.
- R5. The host owns durable sessions; the 3DS reconnects and replays missed state after a WiFi drop or lid-close, without losing in-flight agent work.
- R6. The host maintains a keyed registry of N concurrent agent sessions, each bound to an agent and a working directory.

**Agent adapters & capability**

- R7. The host ships adapters for Claude Code and Codex (v1), each normalizing that agent's events into AgentBus; additional agents are added via the same interface.
- R8. On session start the host negotiates the agent's capabilities (streaming, live approval, interrupt) and the device renders affordances conditionally — no dead buttons for unsupported features.
- R9. Supporting a new agent requires only a new host adapter.

**Input: macropad & voice**

- R10. The bottom screen is a state-driven macropad whose layout the host pushes per live agent state (idle, dictating, pending-approval, menu).
- R11. During a pending tool call, physical face buttons map to approve / deny / approve-and-remember.
- R12. Push-to-talk: holding a shoulder button streams mic PCM to host STT; releasing ends the utterance. Partial transcripts stream back to the top screen live.
- R13. Transcribed filenames and symbols are fuzzy-matched against a host-built repo index; top candidates are offered as macropad taps rather than trusted verbatim.
- R14. An on-screen keyboard is available for free-text and correction, as a fallback rather than the primary path.

**Output & board**

- R15. The top screen shows the board: one tile per session with status; tapping a tile focuses it and routes voice and macropad input to that session.
- R16. A focused session renders a compact HUD (state, current action/tool, change summary), not raw terminal scrollback.

**Approvals & policy**

- R17. Where the agent supports live per-call approval (Claude Code via the Agent SDK `canUseTool` callback; Codex via `app-server` `requestApproval`), the host routes that approval request to the device and blocks until the response.
- R18. A per-repo policy auto-approves low-risk action classes and escalates risky ones (shell, network, deletes) to the device.
- R19. For the allowlist tier (Codex `exec --json` fallback, and future agents without live headless approval), the host runs against a pre-authorized allowlist and the board surfaces done / failed / blocked honestly.

**Security**

- R20a. Every device↔host connection is authenticated from M1: a device token (later a pairing step) gates the connection before any prompt is accepted, and the host binds loopback by default, refusing a non-loopback bind without a token.
- R20b. Transport is encrypted (TLS/wss or an encrypted tunnel) whenever the host is non-local (M4).
- R21. The security model does not rely on hardcoded keys or ports.

**Customization & compounding**

- R22. Macropad layouts are declarative, shareable files; macros compile to AgentBus intents, not agent-specific keystrokes, so one layout survives an agent swap.
- R23. A multi-turn sequence of prompts and approvals can be recorded as a named, replayable routine.
- R24. Session transcripts are logged in a structured form usable as an STT bias/correction corpus over time.

## Key Flows

- F1. **Walking-skeleton loop (milestone 1).** **Trigger:** developer sends a prompt (typed) to a Claude Code session. Host relays it via stream-json; output streams to the top-screen HUD; on a tool call the host surfaces an approval; developer presses A (approve) or B (deny); the agent continues. Runs on real hardware over LAN. **Covers R1, R5, R7, R11, R16, R17.**
- F2. **Push-to-talk voice.** **Trigger:** developer holds the shoulder button and speaks. PCM streams to host STT; partial transcript appears live; release commits the utterance as a prompt to the focused session; identifiers are disambiguated against the repo index. **Covers R3, R12, R13.**
- F3. **Board switching.** **Trigger:** multiple sessions run; a non-focused session hits an approval or finishes. Its tile updates; developer taps it to focus; subsequent voice/macropad input routes there. **Covers R6, R10, R15.**
- F4. **Reconnect.** **Trigger:** the lid closes or WiFi drops mid-task. The host keeps the session running; on reconnect the device replays missed state and resumes. **Covers R5.**

## Acceptance Examples

- AE1. **Covers R5, R8.** A session is running under an agent that supports live approval. The lid closes for two minutes while a tool call is pending. On reopen, the device shows the still-pending approval, not a dead or restarted session.
- AE2. **Covers R17, R19.** A Claude Code tile and a Codex tile both run and both raise live per-call approvals. Each approval routes to the correct tile and its `approve`/`deny` resolves only that session (no cross-wiring); focused input goes only to the focused session. A `codex exec` fallback session, lacking live approval, reads "blocked" (not a fake approve prompt) on a disallowed action.
- AE3. **Covers R12, R13.** The developer dictates "open the auth handler." STT returns an approximate string; the macropad offers the top repo matches (e.g. `middleware/auth.ts`) as taps rather than sending a wrong filename.
- AE4. **Covers R20a, R20b.** The host runs on a VPS. A device that has not completed pairing cannot drive any session, and traffic is not sent in cleartext.

## Success Criteria

Milestone gates (each is the "done" bar for a phase; all six survivors remain in the full plan):

- **M1 — Walking skeleton:** F1 works end-to-end on real 3DS hardware over LAN with Claude Code. Approve/deny feels like one button press, not a typed "yes."
- **M2 — Board + multi-agent:** R6/R7/R8/R15 — Claude Code and Codex run as concurrent tiles with honest status and tap-to-focus routing; concurrent approvals route to the correct tile (AE2).
- **M3 — Voice:** F2 — push-to-talk with live partial transcripts feels responsive over 802.11g; repo-grounded disambiguation keeps the keyboard genuinely optional.
- **M4 — Remote + secure:** R4/R5/R20/R21 — the host runs on a VPS, the 3DS drives it over an authenticated, encrypted link, and sessions survive lid-close.

## Scope Boundaries

**Deferred for later**
- No-mod browser client (lite tier, no voice) — widens reach but is a separate client build.
- Multi-user / classroom swarm (one host, many devices).
- On-device STT — not viable on ARM11; streaming to host is the permanent architecture.
- CIA / HOME-menu distribution — needs full CFW; `.3dsx` is the v1 target.

**Outside this product's identity**
- A full terminal emulator on the 3DS — that is [DSSH](https://github.com/Fishason/DSSH)'s lane; this is a controller, not a terminal.
- An IDE or code editor on-device.
- Running the agent itself on the 3DS — the host always owns the agent.

## Dependencies / Assumptions

- Requires a homebrew-capable 3DS reachable via the Homebrew Launcher (installed through a firmware-appropriate primary exploit); no persistent CFW is strictly required, but there is no single all-firmware one-shot path.
- The host machine has `claude` and `codex` installed and authenticated, with the agents' repos co-located on the host.
- The host runs a whisper implementation (whisper.cpp via Node bindings or shell-out) for STT.
- The 3DS mic captures at 16364.479 Hz (`MICU_SAMPLE_RATE_16360`), not 16 kHz, so the host resamples to exactly 16000 Hz before whisper; the PCM stream fits comfortably in 802.11b/g bandwidth. **Real-world WiFi latency/jitter for voice feel is unverified and needs a hardware test early** (flagged in ideation grounding).
- Both Claude Code (Agent SDK `canUseTool`) and Codex (`app-server` `requestApproval`) expose live per-call approval headless; the `codex exec --json` fallback and future agents are allowlist-only (verified in the deepening pass).

## Outstanding Questions

**Deferred to planning**
- The approval-risk taxonomy behind the per-repo policy (R18).
- Whisper model size vs latency tuning for M3.
- The `.pad` layout file schema and the intent vocabulary macros compile to (R22).
- Durable-session persistence format (R5).
- Codex integration surface: `app-server` (JSON-RPC, stateful, carries approvals) vs `exec --json` (one-shot).
- 3DS encryption approach for M4: port mbedTLS to the client vs require an encrypted network tunnel (R20b).
- Trigger threshold for taking the UDP-audio escape hatch (R3), decided against M3 hardware measurements.

## Sources / Research

- Ideation artifact with full grounding and ranked survivors: [docs/ideation/2026-07-01-3ds-vibe-coding-controller.md](docs/ideation/2026-07-01-3ds-vibe-coding-controller.md)
- Reference / prior art: [rAI3DS](https://github.com/just1jray/rAI3DS) (tmux-injection, the mechanism being replaced), [CTurt/3DSController](https://github.com/CTurt/3DSController) (touch→TCP input), [Fishason/DSSH](https://github.com/Fishason/DSSH) (the "just SSH" alternative to differentiate against).
- Verified constraints: libctru `soc:U` sockets and `MIC` PCM capture; agent CLI headless surfaces (Claude Code Agent SDK `canUseTool` + stream-json, `codex app-server` slash-delimited JSON-RPC + `requestApproval`, `codex exec --json`). Details in the ideation artifact.
