# 3DSendai

**Supervise your coding agents from a Nintendo 3DS.**

Start your agents the way you already do — a [herdr](https://herdr.dev) session running Codex, Claude Code, Cursor, or whatever else — walk to the couch, open the 3DS, and see your whole fleet: every agent pane across every running herdr session, **blocked-first**, so the one that needs you is always at the top. Tap Accept or Deny for the blocked agent's cursor row — no picking up the laptop. And when you actually want to drive a pane — read the plan, type a follow-up, watch it work — a full drop-in terminal is one toggle away. That combination (a supervision board *plus* a real terminal, not a phone dashboard bolted onto a chat UI) is what no other agent-fleet viewer offers.

Your laptop, Pi, or VPS does the heavy lifting; the 3DS is the remote. tmux and the structured Codex/Claude adapters remain fully supported as alternate backends — the terminal mode this project shipped first hasn't gone anywhere.

A spiritual successor to [3Base](https://github.com/MadeOfBees/3Base) — it shares that project's encrypted-transport lineage and is GPL-3.0.

> **Status: early and honest.** The whole stack builds clean and is covered by tests + host-compiled cross-library KATs; the wire is **end-to-end encrypted** (XChaCha20-Poly1305 PSK) with **zero-config UDP discovery**. The core terminal — rendering, touch, keystrokes, alerts — **has survived its first runs on a real 3DS**. The agent board, its deck, QR pairing, and voice capture build clean and are host-verified but are still young on hardware. Trackers: [M1 controller](docs/plans/2026-07-01-001-feat-3ds-vibe-coding-controller-plan.md), [encrypted transport](docs/plans/2026-07-01-002-feat-encrypted-transport-discovery-plan.md), [tmux terminal + macropad](docs/plans/2026-07-01-003-feat-3ds-tmux-terminal-macropad-plan.md), [fidelity + pairing + voice](docs/plans/2026-07-07-004-feat-3ds-fidelity-pairing-voice-plan.md), [herdr backend](docs/plans/2026-07-07-005-feat-herdr-session-backend-plan.md), [agent-supervision board](docs/plans/2026-07-20-001-refactor-agent-supervision-herdr-port-plan.md).

---

## What it is

Three pieces, one encrypted wire protocol:

```
  [ 3DS client ]  <--- WiFi (AgentBus, sealed) --->  [ host ]  <--- session backend --->  [ your herdr / tmux ]
   C / libctru                                    Bun / TypeScript                    codex · claude · cursor · shell
   renders the board + terminal, sends intents    bridges your agents/session         whatever's running in the pane
```

- **The 3DS client** is a homebrew app (`.3dsx`). It renders an agent board (blocked-first, kind/status/title) or a live terminal, sends keystrokes and watched-screen approvals, plays alerts, and speaks one small sealed wire protocol. No agent or shell logic on the handheld.
- **The host** is a single Bun/TypeScript binary you run on your laptop, a Pi, or a VPS. By default it attaches to your running [herdr](https://herdr.dev) daemon(s) — discovering every session, flattening their agent panes into one board, and driving per-pane terminal channels on demand. `SENDAI_BACKEND=tmux` bridges a tmux server instead; `SENDAI_BACKEND=agents` spawns Codex/Claude Code directly (the original controller path). The backend owns persistence and scrollback; the host is just the bridge.
- **AgentBus** is the protocol between them — length-prefixed framed TCP, optionally sealed as XChaCha20-Poly1305 records. Whatever runs inside a pane is opaque to the wire; the board's `kind`/`title`/`status` fields are the one exception, and they're sanitized before they ever reach the device.

**Ported from [AgentSlate](https://github.com/DanielOu1208/agentslate)** (MIT, © Daniel Ou): the herdr session-discovery ordering, the agent-normalization precedence, the per-kind approval keymaps, and the blocked-first dashboard ordering are all AgentSlate's supervision model, re-implemented on 3DSendai's own sealed transport (AgentSlate uses Tailscale + plain NDJSON, which has no path onto a 3DS). Full attribution and what did/didn't transfer: [`host/src/herdr/AGENTSLATE-PORT.md`](host/src/herdr/AGENTSLATE-PORT.md).

---

## Quickstart (herdr / agent board)

**You'll need:** a homebrew-enabled 3DS (Luma3DS / Homebrew Launcher), [Bun](https://bun.sh), [herdr](https://herdr.dev) **0.7.3 or newer** (0.7.4+ recommended — better blocked-agent detection) running your agents, and — only to rebuild the 3DS app yourself — Docker (for the devkitPro toolchain).

**1. Get the app on your 3DS.** Two ways:

- **Install the `.cia` by QR (one-tap).** In **FBI → Remote Install → Scan QR**, scan the install QR below — it pulls the latest `3dsendai.cia` from GitHub Releases and installs it as a home-menu title.

  <img src="../../releases/latest/download/install-qr.png" alt="3DSendai install QR" width="160">

  > ⚠️ **Not yet verified on hardware.** The QR encodes a GitHub `releases/latest/download/` URL that 302-redirects to `objects.githubusercontent.com` over HTTPS, and the 3DS TLS stack is historically flaky with GitHub's certs/SNI/redirects — FBI may fail to negotiate. Fallback: download `3dsendai.cia` to your SD card and install it locally in FBI, or mirror it on plain HTTP. This scan-to-install path has not been confirmed on a physical 3DS.

- **Or side-load the `.3dsx`.** Grab `client/3dsendai.3dsx`, drop it in the `/3ds/` folder on your SD card, reinsert, launch from the Homebrew Launcher. (Rebuild it yourself: `cd client && docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make`.)

**Pair by QR — no rebuild.** Run `bun run host pair` on the host: it mints a PSK and prints a QR code in the terminal. On the 3DS, press **X** (while offline) to open the camera, scan it, done — the secret persists on the SD card (`pair.cfg`) across launches and enables the encrypted transport + automatic host discovery (encrypted UDP broadcast). Compile-time `client/source/config.h` values (`PAIR_PSK`, `SERVER_HOST`, `PAIR_TOKEN`) remain as fallbacks for development.

**2. Start herdr and the host:**

```bash
herdr                                              # your normal herdr session(s), untouched
SENDAI_PSK=$(openssl rand -hex 32) SENDAI_HOST=0.0.0.0 \
  bun run host
```

That's it — `SENDAI_BACKEND` is unset, which now defaults to `herdr`. The host enumerates every **running** herdr session (`herdr session list --json`), attaches to each independently, and flattens their agent panes into one board — no `SENDAI_HERDR_SESSION` needed unless you want to pin one session. Zero running sessions is a valid, empty board (start one and it appears on the next re-enumeration), not an error; a missing `herdr` binary or unreachable daemon is a clear startup log and an on-device `ERROR`, never a hang — and since `herdr` is now the *default* backend rather than something you opted into, that message names `SENDAI_BACKEND=tmux` and `SENDAI_BACKEND=agents` as the escape hatches.

Env: `SENDAI_HERDR_SESSION` (pin one named session — disables multi-session discovery), `SENDAI_HERDR_SOCKET` (explicit api-socket path override, same effect). One backend per host process; the host must run on the machine that owns the herdr socket(s) — the socket has no auth beyond filesystem permissions.

**3. Launch it.** Homebrew Launcher → **3DSendai**, same WiFi. The 3DS discovers the host and lands on the **agent board** — every discovered agent, blocked agents first.

- **Top screen:** the agent board — kind, name, semantic status (`working` / `blocked` / `done` / `idle`), and task title, up to 16 rows with a scrolling viewport and blocked-preferring eviction past that.
- **D-pad:** move the cursor. The cursor tracks the selected agent by identity, not row position — a re-sort or a row disappearing never silently retargets it.
- **A:** focus the cursor row's agent and switch to the terminal (drop-in, full VT/ANSI rendering, real keystrokes, scrollback). **B:** back to the board. **START:** quit (unchanged, never rebound).
- **Board deck (bottom screen):** **Accept / Deny** for the cursor row — enabled only when that row is `blocked` **and** its kind has a known keymap (`codex`, `cursor`, `claude`, `omp`, `opencode` today). A tap disables both buttons and shows "sending…" until the next status update or a short cooldown, so a double-tap can't fire twice. The rest of the deck (arrows, Enter, Esc, Tab, Shift+Tab, push-to-talk) targets the *focused* agent's terminal and stays disabled until one is focused.
- **Alerts:** a blocked agent, a pane exiting, or an agent going idle raises the hinge LED (and a tone), lid-closed — and lands in an on-screen alert log; tap a log row to mute that agent (muted alerts still log).

> **Watched-screen safety.** Accept/Deny is a convenience for an agent whose prompt you can actually see, not a structured authorization system — herdr's `blocked` status carries no request identity, so the host can confirm an agent *looks* blocked but not what it's asking for. This is a direct echo of AgentSlate's own warning: don't wire this up to anything you aren't watching, and remember a custom keymap or non-default TUI binding in the agent itself can make a kind's mapping send the wrong key. The structured, request-identified approval tier (`APPROVAL_REQUEST`/`APPROVAL_RESPONSE`) is reserved for agents that can actually ask.

**Want the old terminal-only setup instead?** `SENDAI_BACKEND=tmux` (bridges your own `tmux new -s <name>` session) or `SENDAI_BACKEND=agents` (the host spawns Codex/Claude Code itself) both still work exactly as before — see [Alternate backends](#alternate-backends).

**Optional — voice input.** Give the host a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) model and push-to-talk lights up (`SENDAI_STT=whisper SENDAI_WHISPER_MODEL=/path/to/ggml-*.bin`, binary override `SENDAI_WHISPER_BIN`, default `whisper-cli`). Transcription is entirely local — nothing leaves your network.

---

## Alternate backends

`SENDAI_BACKEND` picks the session source; herdr is the default when it's unset.

**`SENDAI_BACKEND=tmux`** — drive your own tmux server:

```bash
tmux new -s api                                    # your normal workflow, untouched
SENDAI_BACKEND=tmux SENDAI_TMUX_SESSION=api \
  SENDAI_PSK=$(openssl rand -hex 32) SENDAI_HOST=0.0.0.0 \
  bun run host
```

(`SENDAI_TMUX=1` is a legacy alias for `SENDAI_BACKEND=tmux` and still works.) The bridge runs `tmux -CC` under a small pty helper (control mode needs a controlling tty). Env: `SENDAI_TMUX_SOCKET` (tmux `-L` socket), `SENDAI_TMUX_SESSION` (omit for all sessions). Device sessions map 1:1 to tmux sessions; alerts come from bell/idle heuristics rather than semantic agent state; the board renders sparsely (name + status only, no kind/title/workspace) since tmux has no concept of an "agent."

**`SENDAI_BACKEND=agents`** — the host spawns Codex/Claude Code directly and streams normalized output with live A/B approval on risky tool calls, instead of bridging an external session:

```bash
SENDAI_BACKEND=agents SENDAI_AGENT=codex \
  SENDAI_PSK=$(openssl rand -hex 32) SENDAI_HOST=0.0.0.0 \
  bun run host
```

`SENDAI_AGENT=codex|claude|both`, `SENDAI_SANDBOX` (codex), `SENDAI_PERMISSION` (claude). This was the original controller path and predates the board; it's retained, demoted in docs only — no code removed.

Both env vars, `SENDAI_DISCOVERY=off`, and `SENDAI_DISCOVERY_PORT` apply to every backend the same way.

---

## What works today

- **Agent board:** every agent pane across every running herdr session, blocked-first, with per-kind Accept/Deny gated by a fresh host-side snapshot revalidation. Ported from AgentSlate; herdr is discovered and re-enumerated automatically. Builds clean, host-KAT-covered (device board model, cursor identity, viewport, approval debounce all pure C), and verified end-to-end through the real sealed server — awaiting the same on-device mileage the terminal already has.
- **Drop-in terminal:** attach to your own herdr or tmux session over WiFi, render the pane, send real keystrokes, scroll scrollback, switch between sessions — reconnecting through host restarts and lid-close. Hardware-proven.
- **Device-authoritative sizing + atlas rendering:** the 3DS reports its grid, the host sizes the real terminal to match (wrap once, at device width), and glyphs draw from a GPU texture atlas — one quad per cell, per-cell color.
- **QR pairing:** `bun run host pair` prints a QR; the 3DS camera scans it and persists the PSK to SD — no `config.h` edit, no rebuild.
- **Voice input:** hold ZL, talk, release — the host transcribes locally (whisper.cpp) and injects the text into the focused session for on-device confirmation. Nothing leaves the local network.
- **Attention alerts + on-screen log:** speaker tone + hinge notification LED on attention / session-ended / likely-done, surviving lid-close (`aptSetSleepAllowed(false)`; LED is the guaranteed channel, audio needs a `dspfirm.cdc` dump) — plus a scrollable alert log with per-session tap-to-mute.
- **Encrypted transport** (XChaCha20-Poly1305 AEAD, libsodium⇄Monocypher with a cross-library KAT in CI) and **zero-config UDP discovery** — no hardcoded host IP. Replay, reflection, and cross-session/cross-channel splices all fail authentication by construction.
- **Alternate backends (retained):** tmux (`SENDAI_BACKEND=tmux`) and the structured agent stack (`SENDAI_BACKEND=agents`, spawning Codex/Claude Code with live A/B approval) — see [Alternate backends](#alternate-backends).

## On the roadmap

- **Hardware soak for the new I/O** — the agent board + deck, camera pairing, mic capture, and structured approval overlay build clean and are host-verified; they need the same on-device mileage the core terminal already has.
- **herdr niceties** — a marketplace plugin wrapper for discoverability, and driving herdr orchestration (new panes/worktrees) from the device; today the 3DS is a pickup-and-drive/supervise surface.
- **Structured, request-identified approvals for herdr agents** — the deeper "future trustworthy unattended permission design" AgentSlate's own research points at, gated on agent-native protocols (Codex app-server, ACP) surfacing real request identity.
- **Raw-binary terminal frames** — the escape hatch if hex-in-JSON throughput ever becomes the bottleneck.

---

## Under the hood

- `protocol/` — the AgentBus wire format (length-prefixed framed TCP, optionally sealed as XChaCha20-Poly1305 records), a TypeScript codec, byte-exact golden vectors (plaintext *and* encrypted), and a single-source constants file that generates both the TS types and the C header so the two halves can't drift. Wire contract: [docs/PROTOCOL.md](docs/PROTOCOL.md).
- `host/` — the Bun/TS host: the **session backends** (herdr socket client + discovery + per-pane terminal channel, the default; tmux control-mode bridge + pty helper), the PSK-encrypted (or token-gated loopback) server, UDP discovery responder, QR pair mode, the whisper voice route, and the retained structured stack (session registry, per-agent adapters, approval policy).
- `client/` — the C/libctru homebrew app: the agent board model (pure C, host-KAT'd), a pure-C VT/ANSI terminal emulator + scrollback, a GPU glyph atlas, camera QR scanning (vendored quirc) with SD-persisted pairing, mic push-to-talk, touch UI, and the ndsp/MCU alert layer.

The host is thoroughly tested (`bun test`); the C client's pure core is covered by host-compiled KATs and the whole app is verified by building it (the libctru glue is runtime-unverified without hardware). Agent/contributor conventions live in [`AGENTS.md`](AGENTS.md).

## Develop

```bash
bun install
bun test               # host + protocol suite
bun run typecheck
bun run codegen        # regenerate the TS types + C header from the single source
bun run host           # start the host (see env vars above)
bun run build:host     # compile the host to a single binary (dist/)
client/test/run.sh     # host-compiled C core KATs (no devkitPro needed)
```

Rebuild the C client with the devkitPro Docker image (see Quickstart). Read [`AGENTS.md`](AGENTS.md) before touching the protocol, the C client, or the golden vectors.

---

Spiritual successor to [3Base](https://github.com/MadeOfBees/3Base) · GPL-3.0 · agent-supervision model ported from [AgentSlate](https://github.com/DanielOu1208/agentslate) (MIT, Daniel Ou) · built with [Claude Code](https://claude.com/claude-code). Design notes live in [`docs/`](docs/).
