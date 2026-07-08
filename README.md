# 3DSendai

**Drive a terminal from your Nintendo 3DS.**

Start a session on your Mac or VPS the way you already do — `tmux new -s myproject`, or a [herdr](https://herdr.dev) session — walk to the couch, open the 3DS, and pick that exact session up. The top screen renders the live terminal; the bottom screen is a control strip; flip a toggle and it's a macropad of quick-action keys. Hold a shoulder button and talk instead of typing. Your laptop does the heavy lifting; the 3DS is the remote.

A spiritual successor to [onoSendai](https://github.com/MadeOfBees/onoSendai) — it shares that project's encrypted-transport lineage and is GPL-3.0.

> **Status: early and honest.** The whole stack builds clean and is covered by tests + host-compiled cross-library KATs; the wire is **end-to-end encrypted** (XChaCha20-Poly1305 PSK) with **zero-config UDP discovery**. The core terminal — rendering, touch, keystrokes, alerts — **has survived its first runs on a real 3DS**; the newest device features (QR pairing camera, voice capture, approval overlay) build clean and are host-verified but are still young on hardware. Trackers: [M1 controller](docs/plans/2026-07-01-001-feat-3ds-vibe-coding-controller-plan.md), [encrypted transport](docs/plans/2026-07-01-002-feat-encrypted-transport-discovery-plan.md), [tmux terminal + macropad](docs/plans/2026-07-01-003-feat-3ds-tmux-terminal-macropad-plan.md), [fidelity + pairing + voice](docs/plans/2026-07-07-004-feat-3ds-fidelity-pairing-voice-plan.md), [herdr backend](docs/plans/2026-07-07-005-feat-herdr-session-backend-plan.md).

---

## What it is

Three pieces, one encrypted wire protocol:

```
  [ 3DS client ]  <--- WiFi (AgentBus, sealed) --->  [ host ]  <--- session backend --->  [ your tmux / herdr ]
   C / libctru                                    Bun / TypeScript                    shell · codex · claude
   renders a terminal, sends keystrokes           bridges your session                whatever you run in it
```

- **The 3DS client** is a homebrew app (`.3dsx`). Thin by design: it renders the focused session's terminal, sends keystrokes (typed or spoken), plays alerts, and speaks one small sealed wire protocol. No agent or shell logic on the handheld.
- **The host** is a single Bun/TypeScript binary you run on your laptop, a Pi, or a VPS. In terminal mode it attaches to **your own multiplexer** — a tmux server (control-mode client, keystrokes via `send-keys`) or a herdr daemon (socket client + per-pane terminal channel) — and streams the focused session to the 3DS. The backend owns persistence and scrollback; the host is just the bridge.
- **AgentBus** is the protocol between them — length-prefixed framed TCP, optionally sealed as XChaCha20-Poly1305 records. Whatever runs inside the pane (a shell, `codex`, `claude`, `htop`) is opaque to the wire.

> A structured mode also exists — the host can spawn and normalize Codex / Claude Code directly into a clean HUD with approval routing — but it's retained off the primary path. Terminal mode is the main event.

---

## Quickstart (terminal mode)

**You'll need:** a homebrew-enabled 3DS (Luma3DS / Homebrew Launcher), [Bun](https://bun.sh), `tmux` and `python3` on the host, and — only to rebuild the 3DS app yourself — Docker (for the devkitPro toolchain).

**1. Get the app on your 3DS.** Two ways:

- **Install the `.cia` by QR (one-tap).** In **FBI → Remote Install → Scan QR**, scan the install QR below — it pulls the latest `3dsendai.cia` from GitHub Releases and installs it as a home-menu title.

  <img src="https://github.com/Bee-and-Bones/3DSendai/releases/latest/download/install-qr.png" alt="3DSendai install QR" width="160">

  > ⚠️ **Not yet verified on hardware.** The QR encodes a GitHub `releases/latest/download/` URL that 302-redirects to `objects.githubusercontent.com` over HTTPS, and the 3DS TLS stack is historically flaky with GitHub's certs/SNI/redirects — FBI may fail to negotiate. Fallback: download `3dsendai.cia` to your SD card and install it locally in FBI, or mirror it on plain HTTP. This scan-to-install path has not been confirmed on a physical 3DS.

- **Or side-load the `.3dsx`.** Grab `client/3dsendai.3dsx`, drop it in the `/3ds/` folder on your SD card, reinsert, launch from the Homebrew Launcher. (Rebuild it yourself: `cd client && docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make`.)

**Pair by QR — no rebuild.** Run `bun run host pair` on the host: it mints a PSK and prints a QR code in the terminal. On the 3DS, press **X** (while offline) to open the camera, scan it, done — the secret persists on the SD card (`pair.cfg`) across launches and enables the encrypted transport + automatic host discovery (encrypted UDP broadcast). Compile-time `client/source/config.h` values (`PAIR_PSK`, `SERVER_HOST`, `PAIR_TOKEN`) remain as fallbacks for development.

**2. Start a session and bridge it:**

```bash
tmux new -s api                                    # your normal workflow, untouched
SENDAI_TMUX=1 SENDAI_TMUX_SESSION=api \
  SENDAI_PSK=$(openssl rand -hex 32) SENDAI_HOST=0.0.0.0 \
  bun run host
```

The bridge runs `tmux -CC` under a small pty helper (control mode needs a controlling tty). Env: `SENDAI_TMUX_SOCKET` (tmux `-L` socket), `SENDAI_TMUX_SESSION` (omit for all sessions), `SENDAI_PSK` (same 64 hex as the client's `PAIR_PSK`; enables encryption + discovery), `SENDAI_DISCOVERY=off`, `SENDAI_DISCOVERY_PORT` (default 41337).

**Run [herdr](https://herdr.dev) instead of tmux?** The same pick-up-and-drive works against your herdr daemon (herdr ≥ 0.7.2 — the bridge needs `session.snapshot` and the `terminal session control` channel):

```bash
herdr                                              # your normal herdr session, untouched
SENDAI_BACKEND=herdr \
  SENDAI_PSK=$(openssl rand -hex 32) SENDAI_HOST=0.0.0.0 \
  bun run host
```

Device sessions are herdr **panes**; alerts come from herdr's own agent states (`blocked` → attention, `done` → likely-done) instead of bell/idle heuristics, and re-fire on reconnect if still pending. Env: `SENDAI_HERDR_SESSION` (named herdr session; omit for the default), `SENDAI_HERDR_SOCKET` (explicit api-socket path override). One backend per host process; the host must run on the machine that owns the herdr socket — the socket has no auth beyond filesystem permissions (the same local-trust posture as the tmux backend).

**Optional — voice input.** Give the host a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) model and push-to-talk lights up (`SENDAI_STT=whisper SENDAI_WHISPER_MODEL=/path/to/ggml-*.bin`, binary override `SENDAI_WHISPER_BIN`, default `whisper-cli`). Transcription is entirely local — nothing leaves your network.

**3. Launch it.** Homebrew Launcher → **3DSendai**, same WiFi. The 3DS discovers the host, lists your sessions, and picks one up.

- **Top screen:** the live terminal — a scrolling ANSI view sized to the device (the host reflows the real terminal at the 3DS's width, so wrapping happens once), great for a shell or an agent streaming output, *not* a full-screen TUI like vim.
- **D-pad / L / R:** scroll and page the scrollback (sends nothing).
- **Bottom control strip:** Ctrl (sticky) / Esc / Tab / arrows / Ctrl-C / keyboard. Tap the keyboard button (or a text field) to type.
- **Hold ZL:** push-to-talk — speak, release, and the host's local whisper transcribes it into the focused session as typed text (you confirm with Enter on-device; nothing auto-executes).
- **Pad toggle:** turn the bottom screen into an 8-button macropad — one-tap approve (`y⏎`), deny, Ctrl-C, Enter, Esc, arrows.
- **Session picker:** tap a row to focus another session (SELECT cycles); the whole UI follows it.
- **Alerts:** a bell / a pane dying / an agent going idle or blocked raises the hinge LED (and a tone), lid-closed — and lands in an on-screen alert log; tap a log row to mute that session (muted alerts still log).
- **Approvals (structured mode):** a risky tool call surfaces on the top screen; answer with **A**/**B**, lid open or closed.

---

## What works today

- **Remote tmux terminal:** attach to your own tmux over WiFi, render the pane, send real keystrokes, scroll scrollback, switch between sessions — reconnecting through host restarts and lid-close. Hardware-proven.
- **herdr backend:** the same terminal mode against a [herdr](https://herdr.dev) daemon (`SENDAI_BACKEND=herdr`) — panes as sessions, semantic agent-state alerts, device-sized reflow via herdr's terminal control channel.
- **Device-authoritative sizing + atlas rendering:** the 3DS reports its grid, the host sizes the real terminal to match (wrap once, at device width), and glyphs draw from a GPU texture atlas — one quad per cell, per-cell color.
- **QR pairing:** `bun run host pair` prints a QR; the 3DS camera scans it and persists the PSK to SD — no `config.h` edit, no rebuild.
- **Voice input:** hold ZL, talk, release — the host transcribes locally (whisper.cpp) and injects the text into the focused session for on-device confirmation. Nothing leaves the local network.
- **Macropad mode:** a toggleable grid of quick-action keys for the focused session.
- **Attention alerts + on-screen log:** speaker tone + hinge notification LED on attention / session-ended / likely-done, surviving lid-close (`aptSetSleepAllowed(false)`; LED is the guaranteed channel, audio needs a `dspfirm.cdc` dump) — plus a scrollable alert log with per-session tap-to-mute.
- **Encrypted transport** (XChaCha20-Poly1305 AEAD, libsodium⇄Monocypher with a cross-library KAT in CI) and **zero-config UDP discovery** — no hardcoded host IP. Replay, reflection, and cross-session/cross-channel splices all fail authentication by construction.
- **Structured mode (retained):** the host can also spawn **Codex** (`codex exec`) or **Claude Code** (`claude -p`) and stream normalized output with live A/B approval on risky tool calls — the original controller path, off the main road now.

## On the roadmap

- **Hardware soak for the new I/O** — the camera pairing, mic capture, and approval overlay build clean and are host-verified; they need the same on-device mileage the core terminal already has.
- **herdr niceties** — a marketplace plugin wrapper for discoverability, and driving herdr orchestration (new panes/worktrees) from the device; today the 3DS is a pickup-and-drive surface.
- **Raw-binary terminal frames** — the escape hatch if hex-in-JSON throughput ever becomes the bottleneck.

---

## Under the hood

- `protocol/` — the AgentBus wire format (length-prefixed framed TCP, optionally sealed as XChaCha20-Poly1305 records), a TypeScript codec, byte-exact golden vectors (plaintext *and* encrypted), and a single-source constants file that generates both the TS types and the C header so the two halves can't drift. Wire contract: [docs/PROTOCOL.md](docs/PROTOCOL.md).
- `host/` — the Bun/TS host: the **session backends** (tmux control-mode bridge + pty helper; herdr socket client + per-pane terminal channel), the PSK-encrypted (or token-gated loopback) server, UDP discovery responder, QR pair mode, the whisper voice route, and the retained structured stack (session registry, per-agent adapters, approval policy).
- `client/` — the C/libctru homebrew app: a pure-C VT/ANSI terminal emulator + scrollback, a GPU glyph atlas, camera QR scanning (vendored quirc) with SD-persisted pairing, mic push-to-talk, touch UI, and the ndsp/MCU alert layer.

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

Spiritual successor to [onoSendai](https://github.com/MadeOfBees/onoSendai) · GPL-3.0 · built with [Claude Code](https://claude.com/claude-code). Design notes live in [`docs/`](docs/).
