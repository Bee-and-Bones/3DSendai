# 3DSendai

**Drive a terminal from your Nintendo 3DS.**

Start a session on your Mac or VPS the way you already do — `tmux new -s myproject` — walk to the couch, open the 3DS, and pick that exact session up. The top screen renders the live terminal; the bottom screen is a control strip; flip a toggle and it's a macropad of quick-action keys. Your laptop does the heavy lifting; the 3DS is the remote.

A spiritual successor to [onoSendai](https://github.com/MadeOfBees/onoSendai) — it shares that project's encrypted-transport lineage and is GPL-3.0.

> **Status: early and honest.** The whole stack builds clean and is covered by tests + host-compiled cross-library KATs; the wire is **end-to-end encrypted** (XChaCha20-Poly1305 PSK) with **zero-config UDP discovery**. **On-hardware behavior — terminal rendering, touch, audio, LED — is not yet verified on a real 3DS.** Trackers: [M1 controller](docs/plans/2026-07-01-001-feat-3ds-vibe-coding-controller-plan.md), [encrypted transport](docs/plans/2026-07-01-002-feat-encrypted-transport-discovery-plan.md), [tmux terminal + macropad](docs/plans/2026-07-01-003-feat-3ds-tmux-terminal-macropad-plan.md).

---

## What it is

Three pieces, one encrypted wire protocol:

```
  [ 3DS client ]  <--- WiFi (AgentBus, sealed) --->  [ host ]  <--- tmux -CC --->  [ your tmux ]
   C / libctru                                    Bun / TypeScript              shell · codex · claude
   renders a terminal, sends keystrokes           bridges your session          whatever you run in it
```

- **The 3DS client** is a homebrew app (`.3dsx`). Thin by design: it renders the focused session's terminal, sends keystrokes, plays alerts, and speaks one small sealed wire protocol. No agent or shell logic on the handheld.
- **The host** is a single Bun/TypeScript binary you run on your laptop, a Pi, or a VPS. In terminal mode it attaches to **your own tmux server** as a control-mode client, streams a session's pane to the 3DS, and injects the device's keystrokes with `send-keys`. tmux owns persistence and scrollback; the host is just the bridge.
- **AgentBus** is the protocol between them — length-prefixed framed TCP, optionally sealed as XChaCha20-Poly1305 records. Whatever runs inside the tmux pane (a shell, `codex`, `claude`, `htop`) is opaque to the wire.

> A structured mode also exists — the host can spawn and normalize Codex / Claude Code directly into a clean HUD with approval routing — but it's retained off the primary path. Terminal mode is the main event.

---

## Quickstart (terminal mode)

**You'll need:** a homebrew-enabled 3DS (Luma3DS / Homebrew Launcher), [Bun](https://bun.sh), `tmux` and `python3` on the host, and — only to rebuild the 3DS app yourself — Docker (for the devkitPro toolchain).

**1. Get the app on your 3DS.** Grab `client/3dsendai.3dsx`, drop it in the `/3ds/` folder on your SD card, reinsert. (Rebuild it yourself: `cd client && docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make`.)

Configure `client/source/config.h` before building: set `PAIR_PSK` to 64 hex chars (`openssl rand -hex 32`) to enable the encrypted transport — with a PSK the 3DS **finds your host automatically** (encrypted UDP broadcast) and `SERVER_HOST` is only a fallback. Leave `PAIR_PSK` empty for plaintext loopback dev with `PAIR_TOKEN` alone.

**2. Start a session and bridge it:**

```bash
tmux new -s api                                    # your normal workflow, untouched
SENDAI_TMUX=1 SENDAI_TMUX_SESSION=api \
  SENDAI_PSK=$(openssl rand -hex 32) SENDAI_HOST=0.0.0.0 \
  bun run host
```

The bridge runs `tmux -CC` under a small pty helper (control mode needs a controlling tty). Env: `SENDAI_TMUX_SOCKET` (tmux `-L` socket), `SENDAI_TMUX_SESSION` (omit for all sessions), `SENDAI_PSK` (same 64 hex as the client's `PAIR_PSK`; enables encryption + discovery), `SENDAI_DISCOVERY=off`, `SENDAI_DISCOVERY_PORT` (default 41337).

**3. Launch it.** Homebrew Launcher → **3DSendai**, same WiFi. The 3DS discovers the host, lists your tmux sessions, and picks one up.

- **Top screen:** the live terminal — a scrolling ANSI view, great for a shell or an agent streaming output, *not* a full-screen TUI like vim.
- **D-pad / L / R:** scroll and page the scrollback (sends nothing).
- **Bottom control strip:** Ctrl (sticky) / Esc / Tab / arrows / Ctrl-C / keyboard. Tap the keyboard button (or a text field) to type.
- **Pad toggle:** turn the bottom screen into an 8-button macropad — one-tap approve (`y⏎`), deny, Ctrl-C, Enter, Esc, arrows.
- **Session picker:** tap a row to focus another tmux session; the whole UI follows it.
- **Alerts:** a tmux bell / a pane dying / activity-then-idle raises the hinge LED (and a tone), lid-closed.

---

## What works today

- **Remote tmux terminal:** attach to your own tmux over WiFi, render the pane, send real keystrokes, scroll scrollback, switch between sessions — reconnecting through host restarts and lid-close.
- **Macropad mode:** a toggleable grid of quick-action keys for the focused session.
- **Attention alerts:** speaker tone + hinge notification LED on bell / session-ended / likely-done, surviving lid-close (`aptSetSleepAllowed(false)`; LED is the guaranteed channel, audio needs a `dspfirm.cdc` dump).
- **Encrypted transport** (XChaCha20-Poly1305 AEAD, libsodium⇄Monocypher with a cross-library KAT in CI) and **zero-config UDP discovery** — no hardcoded host IP. Replay, reflection, and cross-session/cross-channel splices all fail authentication by construction.
- **Structured mode (retained):** the host can also spawn **Codex** (`codex exec`) or **Claude Code** (`claude -p`) and stream normalized output — the original controller path, off the main road now.

## On the roadmap

- **A device-side terminal that survives real hardware** — the on-3DS renderer, touch, audio, and LED are unverified until the first hardware run.
- **Live per-call approval in structured mode** — surface an agent's risky tool call on the top screen, hit **A**/**B**.
- **Voice.** Hold a shoulder button, talk, let go — mic streams to host STT and becomes input. (Host audio pipeline exists; on-device mic is next.)
- **Pairing UX** — on-device PSK mint + display, so `config.h` editing isn't the only path.

---

## Under the hood

- `protocol/` — the AgentBus wire format (length-prefixed framed TCP, optionally sealed as XChaCha20-Poly1305 records), a TypeScript codec, byte-exact golden vectors (plaintext *and* encrypted), and a single-source constants file that generates both the TS types and the C header so the two halves can't drift. Wire contract: [docs/PROTOCOL.md](docs/PROTOCOL.md).
- `host/` — the Bun/TS host: the **tmux bridge** (control-mode parser + pty helper), the PSK-encrypted (or token-gated loopback) server, UDP discovery responder, and the retained structured stack (session registry, per-agent adapters, approval policy).
- `client/` — the C/libctru homebrew app: a pure-C VT/ANSI terminal emulator + scrollback, bundled monospace font, touch UI, and the ndsp/MCU alert layer.

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
