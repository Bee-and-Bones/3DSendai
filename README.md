# ag3nt

**Vibe-code from your Nintendo 3DS.**

Type a prompt on the touch screen. Watch a real coding agent think, work, and stream its answer back to the top screen. Close the lid, walk to the couch, flip it back open, keep going. Your laptop does the heavy lifting; the 3DS is the controller.

This is not a terminal crammed onto a 320x240 screen. It is a purpose-built controller for steering coding agents, leaning into what the 3DS is genuinely good at: two screens, physical buttons, a stylus, a mic. You bring the vibes; the agent writes the code.

> **Status: early and honest.** The M1 loop works today (connect over WiFi, type a prompt, watch an agent stream a reply, auto-reconnect through sleep) — and the wire is now **end-to-end encrypted** (XChaCha20-Poly1305, pre-shared key) with **zero-config discovery**: the 3DS finds your host by encrypted UDP broadcast, no hardcoded IP. Crypto + discovery design merged from the sibling project **onoSendai**. Voice input, a multi-agent board, and live approve/deny are on the way. See the [build tracker](docs/plans/2026-07-01-001-feat-3ds-vibe-coding-controller-plan.md) for exactly what's done.

---

## What it is

Three pieces, one clean protocol:

```
  [ 3DS client ]  <--- WiFi (AgentBus) --->  [ host ]  <--- spawns --->  [ your agent CLI ]
   C / libctru                            Bun / TypeScript              codex · claude code
   type / tap / (soon) talk              runs in your repo
```

- **The 3DS client** is a homebrew app. Thin by design: it draws the UI, takes your input, and speaks one small wire protocol. No agent logic on the handheld.
- **The host** is a single Bun/TypeScript binary you run on your laptop, a Pi, or a VPS. It owns the session, drives your agent CLI, and streams everything back to the 3DS. Deploy it on a box that's always on and your 3DS becomes a standalone remote coding device.
- **AgentBus** is the protocol between them. The device never learns which agent it's driving. Swapping Codex for Claude Code is a host-side detail.

Today it drives **Codex** and **Claude Code** via their CLIs. Adding another agent is a host adapter, not a firmware change.

---

## Quickstart

**You'll need:** a homebrew-enabled 3DS (Luma3DS / Homebrew Launcher), [Bun](https://bun.sh), an agent CLI logged in (`codex` or `claude`), and — only to rebuild the 3DS app yourself — Docker (for the devkitPro toolchain).

**1. Get the app on your 3DS.** Grab `client/ag3nt.3dsx`, drop it in the `/3ds/` folder on your SD card, and reinsert the card. (Building it yourself: `cd client && docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make`.)

Configure `client/source/config.h` before building: set `PAIR_PSK` to 64 hex chars (`openssl rand -hex 32`) to enable the encrypted transport — with a PSK the 3DS **finds your host automatically** (encrypted UDP broadcast) and `SERVER_HOST` is only a fallback. Leave `PAIR_PSK` empty for plaintext loopback dev with `PAIR_TOKEN` alone.

**2. Start the host** on the same WiFi:

```bash
AG3NT_HOST=0.0.0.0 AG3NT_PORT=4791 AG3NT_TOKEN=ag3nt-3ds \
  AG3NT_AGENT=codex AG3NT_CWD=/path/to/your/repo \
  bun run host
```

- `AG3NT_AGENT` = `codex` or `claude`. `AG3NT_CWD` is the repo the agent works in.
- Codex sandbox defaults to `workspace-write`; use `AG3NT_SANDBOX=read-only` for a cautious first run.
- Non-loopback binds require a token or PSK (the host refuses to run open on the network without one).
- Set `AG3NT_PSK` (same 64 hex chars as the client's `PAIR_PSK`) to encrypt everything and enable discovery. Wire spec: [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Discovery is on by default when a PSK is set; `AG3NT_DISCOVERY=off` disables it and `AG3NT_DISCOVERY_PORT` (default 41337) changes the UDP port.

**3. Launch it.** Homebrew Launcher → **ag3nt**. The header shows `reconnecting…`, then your agent and its status. Press **X**, type a prompt, and watch the top screen. **START** quits.

That's the loop: prompt in, agent works, answer streams back. From a 3DS.

---

## What works today

- Connect to the host over WiFi with a shared token, and **auto-reconnect** through host restarts and closing the lid.
- **Encrypted transport** (XChaCha20-Poly1305 AEAD, libsodium⇄Monocypher with a cross-library KAT in CI) and **zero-config UDP discovery** — no hardcoded host IP. Replay, reflection, and cross-session splices all fail authentication by construction.
- Type a prompt on the touch keyboard; the focused agent runs it in your repo.
- Watch streamed output on the top screen.
- Drive **Codex** (`codex exec`) or **Claude Code** (`claude -p`), swappable from the host.

## On the roadmap

- **Voice.** Hold a shoulder button, talk, let go. The mic streams to the host, gets transcribed, and becomes your prompt. (The audio pipeline is built host-side; the on-device mic is next.)
- **Live approve / deny.** When the agent wants to run something risky, the top screen shows what, and you hit **A** or **B**. The console's whole reason for being.
- **The board.** Several agents at once, one tile each. Glance down: which one needs you? Tap to focus.
- **Remote for real.** Run the host on a VPS and code from anywhere your 3DS has WiFi — the encrypted link already exists; pairing UX (on-device key mint) is the missing piece.

---

## Under the hood

- `protocol/` — the AgentBus wire format (length-prefixed framed TCP, optionally sealed as XChaCha20-Poly1305 records), a TypeScript codec, byte-exact golden test vectors (plaintext *and* encrypted), and a single-source constants file that generates both the TS types and the C header so the two halves can't drift. Wire contract: [docs/PROTOCOL.md](docs/PROTOCOL.md).
- `host/` — the Bun/TS host: PSK-encrypted (or token-gated loopback) server, UDP discovery responder, N-session registry with durable reconnect/replay, per-agent adapters over a shared subprocess layer, capability negotiation, an approval policy engine, and the audio/STT + repo-disambiguation pipeline.
- `client/` — the C/libctru homebrew app.

The host is thoroughly tested (`bun test`); the C client is verified by building it. See [`client/README.md`](client/README.md) for build details and honest caveats.

## Develop

```bash
bun install
bun test          # host + protocol suite
bun run typecheck
bun run host      # start the host (see env vars above)
bun run build:host  # compile the host to a single binary (dist/)
```

Rebuild the C client with the devkitPro Docker image (see Quickstart). Refresh the generated protocol header with `bun run codegen`.

---

Built with [Claude Code](https://claude.com/claude-code). Design notes live in [`docs/`](docs/) — ideation, requirements, and the build tracker.
