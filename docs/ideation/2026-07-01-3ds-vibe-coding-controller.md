# Ideation: 3DS Vibe-Coding Controller (rAI3DS, generalized)

**Date:** 2026-07-01
**Focus:** Expand [rAI3DS](https://github.com/just1jray/rAI3DS) into a general-purpose "vibe coding controller" that runs on a Nintendo 3DS and drives coding-agent CLIs (Claude Code, Codex, and others) over a clean host protocol. Voice input via the 3DS mic; touch screen as an on-screen keyboard *or* a customizable macropad. Host/bridge preferably Rust. Also: run the host on a **VPS** so the 3DS is a standalone remote coding device.
**Status:** Ideation complete. Next step: `ce-brainstorm` on the chosen direction, then `ce-plan`.

---

## Grounding (verified)

**Reference (rAI3DS today):** 3DS homebrew (C/libctru, `.3dsx`) ↔ Bun/TS companion server (:3333) over a hand-rolled WebSocket. The server drives Claude Code by **installing hooks + injecting `tmux send-keys` + regex-scraping the tmux pane**. Commit history shows the author bounced between pure-hooks, pure-scraping, and a hybrid because none was reliable alone. Claude-Code-only; mic + other agents are TODOs. No auth/encryption anywhere (fine on LAN, unsafe on a VPS). Solo hobby MVP, 0 stars — genuine working prototype, not a product.

**3DS hardware reality:**
- **CPU/RAM:** ARM11 @ 268 MHz stock (New 3DS clocks to 804 MHz only under a flag); 128 MB FCRAM (256 MB New). A bad terminal, a fine controller.
- **WiFi:** 802.11 b/g, 2.4 GHz only — even New 3DS. Sockets via libctru `soc:U` (BSD-like, max 64, 1 MB page-aligned buffer, no IPv6). UDP preferred for the audio stream to avoid TCP stalls.
- **Mic:** libctru `MIC` service, PCM8/16 at fixed hardware rates via shared memory (~8/16/32 kHz — the "16 kHz" option is actually 16364.479 Hz, so the host must resample to exactly 16000 for whisper). **Exclusive access** (one process). On-device STT is **not viable** → stream PCM to host, run whisper there (rAI3DS's own plan agrees).
- **Screens:** top 400×240 (output), bottom 320×240 touch. Touch is a simple polling API (`hidScanInput`/`hidTouchRead`); custom keyboards + button grids are well-trodden in homebrew (3DSController, HBKBLib), and a native `swkbd` applet exists for free-text.
- **Toolchain:** devkitPro/libctru (C) is the live mainstream (v2.7.0, active). LÖVE Potion (Lua) is the actively-maintained higher-level alternative. ctrulua is dead.
- **Distribution gate (nuanced):** A `.3dsx` runs via the Homebrew Launcher, which is reached through a firmware-appropriate primary exploit (the current hacks.guide vector for the target's firmware) that installs the hbmenu payload — not a single all-firmware one-shot (kartdlphax, for instance, is a helper for staging secondary exploits and assumes an already-modded console). **CIA install** (appears on the HOME Menu) needs full Luma3DS/boot9strap CFW. So target **`.3dsx`/hbmenu**: lighter than CIA, but still a per-firmware setup step for the recipient — not zero-friction for a total non-hacker, which keeps the no-mod browser tier (Fork A) worth weighing.
- **Text rendering:** citro2d draws bitmap-atlas text (CFNT/BCFNT, no TTF); `C2D_TextOptimize` mitigates glyph texture-swap cost, but "enough glyphs on screen can still cause dropped frames." → reinforces rendering a **HUD/summary, not raw terminal scrollback** (Survivor #3).

**Prior art (input half, near proof-of-concept):** [CTurt/3DSController](https://github.com/CTurt/3DSController) already does touch-screen-as-keyboard + streams input to a PC over TCP — the "handheld talking to a host" half of this idea, minus the agent layer.

**Prior art to differentiate against:** [Fishason/DSSH](https://github.com/Fishason/DSSH) is a working 3DS SSH client with a citro2d ANSI terminal — its README says *"Run tmux + claude-code from a 3DS."* That's the "just SSH into a full terminal" alternative. This project's bet is the opposite: **not a terminal on a tiny screen, but a purpose-built controller** (voice + contextual macropad + physical approve/deny) that leans into what the 3DS is good at (buttons, mic, two screens) and away from what it's bad at (rendering/scrolling a terminal). `ce-brainstorm` should sharpen this "why not just SSH" answer.

**Agent CLI surfaces (the load-bearing finding):**
- Common denominator is real: every CLI can *spawn as a subprocess, take a prompt via arg/stdin, emit newline-delimited `{type:...}` JSON events, and signal a terminal "done" event.* But the event schemas **diverge** → a per-agent adapter/normalizer is mandatory; no single parser works for all four.
- **Approval divergence is the sharp edge.** **Claude Code** offers a documented live per-call approval primitive headless (Agent SDK `canUseTool`, which can defer indefinitely — no MCP tool required). **Codex** matches it through `app-server` (bidirectional JSON-RPC over stdio with a `requestApproval` workflow); only its `exec --json` one-shot mode is allowlist-only. So both v1 agents can drive a live approve/deny console — allowlist-only is the fallback, not the rule.
- Per-agent adapter map (v1):
  - Claude Code → Agent SDK with the `canUseTool` callback (native live approval + streaming); no MCP permission tool needed.
  - Codex → `codex app-server` (stateful JSON-RPC with a `requestApproval` workflow) or `codex exec --json` (one-shot, allowlist-only).

**Topic axes used for divergence:** (1) agent transport/CLI abstraction, (2) input modality, (3) voice pipeline, (4) on-device output & feedback, (5) host architecture/config. All five got coverage across 6 ideation frames (~48 raw candidates).

---

## The convergence

Across all six frames the ~48 ideas collapse onto a handful of decisions. The strongest, most-repeated spine:

> **Kill tmux key-injection. Define one stable, device-agnostic *and* agent-agnostic wire protocol ("AgentBus"): state frames down to the device, semantic input events up. The host owns per-agent adapters and the durable session. The 3DS is a thin, reconnectable I/O client — one of several possible clients — that never learns a CLI exists.**

Everything else (voice, macropad, approvals, VPS, multi-agent) hangs off that spine. Below are the survivors after critique, ranked by leverage.

---

## Survivors (ranked)

### 1. AgentBus — one protocol, host-side adapters, no tmux
Replace hooks + `tmux send-keys` + screen-scraping with a thin adapter per agent that speaks each CLI's real machine interface, normalized into one versioned envelope (`prompt`, `output-chunk`, `tool-call`, `approval-request`, `status`, `interrupt`). The 3DS speaks only AgentBus; adding another agent is a host-side plugin, never a firmware change.
- **Why it's #1:** It's the precondition for *everything* the project wants. tmux injection is the single root cause of rAI3DS's flakiness and its Claude-only lock-in. Firmware iteration on ARM11 is slow and risky — pushing all agent-specific logic host-side means the slow-to-change component stops changing.
- **Basis:** *direct* (rAI3DS's own commit history proves tmux-scraping is unreliable; every target CLI has a documented non-TUI surface). *reasoned* (schemas diverge → normalizer is mandatory anyway).
- **Frames:** pain, inversion, leverage (×3), assumption, cross-domain (MIDI-learn), constraint.

### 2. Deployable host + durable session + thin reconnectable client (the VPS unlock)
The host is a **deployable service, not a laptop script**: it runs the same on your laptop, a home Pi, or your VPS. It *owns* the agent process and an output buffer; the 3DS is a reconnectable client that replays missed events on wake. Close the lid / roam WiFi / connect from another network → the session is still there.
- **Why it matters:** This is your VPS idea, and it's what turns a desk novelty into a **standalone remote coding device** — code from the couch or anywhere with WiFi, no laptop on. It also fixes the sleeper flow-killer (3DS sleeps on lid-close; a client-owned socket session dies every time).
- **New requirement it forces:** rAI3DS's plaintext LAN WS with a hardcoded key is unacceptable over the open internet. A VPS host needs **auth + TLS/wss + a pairing step** — a first-class security axis rAI3DS skips entirely.
- **Basis:** *direct* (sockets over WiFi work; agents run headless on any host). *reasoned* (nothing in the host/client split requires the host to be the user's active laptop).
- **Frames:** pain (resilience), inversion (Pi), assumption (thin client), constraint (cloud-only, no host).

### 3. State-driven contextual macropad + physical approve/deny console
The bottom screen is **not a static grid** — the host pushes the layout in real time from live agent state. Dictating → record/stop/redo. Pending tool call → the top screen shows the command/diff and the bottom becomes **A=approve, B=deny, X=approve-and-remember** (mapped to the 3DS's idle physical buttons). Idle → saved prompt snippets + agent switch. The two screens become a permanent **"what's it about to do" + "yes/no"** console — the exact moment being off your keyboard matters (you're reviewing, not writing).
- **Why it matters:** Approvals are the highest-frequency, highest-stakes interaction and the human-in-the-loop bottleneck for autonomous agents. Turning them from multi-tap keyboard chores into one button press dominates felt latency. This is the emotional core of the product.
- **Sharp constraint (from grounding):** live per-call approval works cleanly with **Claude Code** (SDK `canUseTool`) and **Codex** (`app-server` `requestApproval`); one-shot/allowlist modes degrade to blocked-status. The UI must be **capability-aware** (see #5) — show the approve/deny console when the agent supports it, degrade gracefully when it doesn't.
- **Basis:** *direct* (Claude SDK `canUseTool`; 3DS has idle A/B/X/Y; touch grid redraws per frame). *external* (aviation challenge-response checklist; Stream Deck contextual pages; MMO action-bar swapping).
- **Frames:** pain (×3), inversion, assumption (×2), cross-domain (×3), constraint.

### 4. Push-to-talk voice with streaming partial STT + repo-grounded disambiguation
Hold a shoulder button = stream mic PCM to host whisper; release = end-of-utterance (push-to-talk solves endpointing, false triggers, privacy, and bandwidth in one gesture — no VAD on ARM11). Show **partial transcripts live** on the top screen so words appear as you speak instead of shouting into a void. Critically: **don't trust STT for identifiers** — fuzzy-match transcribed filenames/symbols against the repo's actual file tree + symbol index and offer the top 3 as macropad taps ("open the auth handler" → tap `middleware/auth.ts`). Voice-for-code dies on proper nouns; grounding against the repo is what keeps the keyboard genuinely optional.
- **Why it matters:** Voice is the headline input and the one thing a 320×240 resistive keyboard can never beat. But naive dictation feels broken; streaming partials + repo grounding are what make it actually usable.
- **Basis:** *direct* (mic PCM works; on-device STT infeasible → host whisper; 3DS has shoulder buttons + speaker; host has the filesystem). *reasoned* (whisper reliably botches camelCase/code tokens → closed-set pick beats open transcription).
- **Frames:** pain, inversion (×2), assumption, cross-domain (walkie-talkie), constraint (×2).

### 5. Capability negotiation + policy-based approval escalation
On connect, the host tells the device which features the active agent supports (streaming? live approval? interrupt? cost telemetry?) and the device renders conditionally — one UI codebase serves all agents, no dead buttons. Layered on top: a **per-repo approval policy** so the host auto-approves the boring 90% (reads, edits under `src/`) and only escalates genuinely risky calls (shell, network, deletes) to the 3DS.
- **Why it matters:** Two problems, one mechanism. Capability negotiation is what makes "any CLI" not fork into N UIs. Policy escalation is what makes **remote/hands-off supervision from a tiny screen tolerable** — and it's what gives allowlist-tier agents a coherent approval story (pre-authorize the safe superset; escalate the rest by re-prompting or sandboxing).
- **Basis:** *reasoned* (agents emit structured tool events the host can classify before bothering the human). *direct* (the four CLIs have genuinely different approval surfaces per grounding).
- **Frames:** inversion (policy), leverage (capability map).

### 6. Compounding customization: shareable layouts, intent-based macros, recordable routines
Macropad layouts are plain declarative `.pad` files (key → action) that live in a repo, diff, and share — a "React layout," a "git-ops layout," a "debugging layout" become importable community artifacts (the QMK/Stream Deck model). Macros compile to **AgentBus intents, not keystrokes** ("run tests," "commit staged") so one macro library survives every agent swap. And a **TASbot-style routine recorder** captures a multi-turn sequence (prompts + approvals) as a named, replayable procedure. Every session is logged as a structured transcript → a free correction corpus that biases future STT toward your domain vocab ("libctru" ≠ "lib C true").
- **Why it matters:** This is what makes the platform's value grow with use instead of staying flat. Intent-based macros are also what stop the layout library from fragmenting per-agent (without it, #6 loses most of its shareable value).
- **Basis:** *external* (QMK keymaps, Stream Deck profiles, MIDI-learn, TAS input scripts). *reasoned* (transcript log = STT training data for free).
- **Frames:** leverage (×3), cross-domain (×2), constraint.

---

## Two strategic forks to resolve in `ce-brainstorm` (not build items — decisions)

**Fork A — Reach: homebrew-only vs a no-mod tier.**
Given the 2026 distribution reality (recipients need Luma3DS CFW), a homebrew `.3dsx` client caps the audience to the modded-3DS community. The assumption-breaking frame surfaced a **no-mod tier**: serve the controller UI (touch macropad + on-screen keyboard + output) to the stock 3DS *browser* over HTTP — losing raw mic + sockets (so no voice, degraded transport) but gaining "works on a 3DS you bought yesterday." Because the host owns everything (Survivor #2), a browser client is just another AgentBus client. Decide: is this a two-tier product (homebrew = full/voice, browser = lite/no-mod), or homebrew-only?

**Fork B — Identity: single-session remote vs multi-agent orchestration board.**
Is this "one 3DS drives one agent session" or "one 3DS conducts N agents at once"? The scarce human resource in 2026 agent work is *attention/switching across many long-running agents*, not keystrokes. A physical multi-tile board ("Claude on repo A, Codex on repo B, another agent on C — which needs me now?") is genuinely better at that than alt-tabbing terminals, and the swarm/VPS architecture (host owns a keyed session registry) is the same refactor either way. Decide the headline framing before `ce-plan`, because it shapes the top-screen UX and the host's session model.

---

## Rejected / demoted (with reasons)

- **Sneakernet prompt cartridges / offline prompt compiler** (constraint frame): clever offline-first authoring, but solves a problem you don't have — your VPS direction is explicitly *live remote*. Interesting fallback, not the main line.
- **Target every retro device now (PSP/GBA link-cable)** (constraint frame): the device-agnostic *protocol* is real leverage and is kept in Survivor #1/#2; committing to actual PSP/GBA ports now is scope creep.
- **"It's a game, not a macropad" full diegetic reskin** (assumption frame): fun and differentiating, but risky as the *core* identity — keep as flavor/stretch, revisit under Fork B.
- **Buttons-only command grammar / scanning keyboard** (constraint, cross-domain): good as accessibility/fallback *modes*, folded into Survivor #3; not headline.
- **Auto-detect agent by capability probe** (inversion frame): nice DX, absorbed into Survivor #5's capability negotiation; not a standalone idea.

---

## Recommended next step

Take **Survivors #1 + #2 together** (AgentBus protocol + deployable/VPS host with durable session and security) into `ce-brainstorm` as the spine, and resolve **Fork A and Fork B** there — those two decisions gate the client scope and the host session model that `ce-plan` will build against. Survivors #3–#6 are the feature surface that follows once the spine and forks are settled.
