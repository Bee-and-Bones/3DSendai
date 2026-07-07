# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## AgentBus
The single wire protocol between the 3DS client and the host: length-prefixed framed TCP, state and output flowing down to the device, semantic input events flowing up. The device speaks only AgentBus and never learns which agent it is driving.

## Host
The deployable service (Bun/TypeScript) that owns durable sessions, spawns the agent CLIs, normalizes their output into AgentBus, and serves the device. Runs on a laptop, Pi, or VPS.

## Client
The thin 3DS homebrew app (C/libctru). Draws the UI, captures input (touch, buttons, and eventually mic), and speaks AgentBus. No agent logic runs on the device.

## Adapter
A host-side component that drives one coding-agent CLI (e.g. Codex, Claude Code) and normalizes its native event stream into neutral AdapterEvents. Adding a new agent is a new adapter, not a device change.

## Session registry
The host's keyed set of concurrent agent sessions — the backing for the multi-agent board. Each session binds an agent, a working directory, and a durable output buffer, and is addressable by id.

## Capability negotiation
Per-session advertisement of what the bound agent supports (streaming, live approval, interrupt), so the device renders only the affordances that apply.

## Live-approval tier vs allowlist tier
Two approval capability classes. Live-approval agents can pause a tool call for a device approve/deny (Claude Code, Codex app-server). Allowlist-tier runs (e.g. `codex exec`) pre-authorize actions and surface out-of-policy ones as blocked.

## Macropad layout
A host-pushed, state-keyed set of bottom-screen buttons (idle, dictating, pending-approval, menu). The host decides the layout for the focused session's current state; the device just renders it.

## Push-to-talk
The planned voice input: hold a shoulder button to stream mic PCM to the host, transcribe there (the device cannot run STT), and turn the result into a prompt.

## PSK
The 32-byte pre-shared key (64 hex chars) that activates the secure transport. Shared out-of-band: `SENDAI_PSK` on the host, `PAIR_PSK` in the client's `config.h`. When set, every frame is an XChaCha20-Poly1305 record and the AEAD tag is the authenticator; when unset, both ends speak plaintext with token auth (the loopback dev mode).

## Secure record
One encrypted AgentBus frame on the wire: `nonce(24) ‖ ciphertext ‖ mac(16)` under a u32 length prefix. The AAD binds context, direction, epoch, and sequence, so replayed, reflected, reordered, or cross-channel-spliced records fail authentication and drop the connection. Spec: `docs/PROTOCOL.md`.

## Epoch
Eight random bytes the host mints per TCP connection and sends cleartext at accept; both ends bind it into every record's AAD. Defeats cross-session replay — a frame captured from an old connection cannot validate under a fresh epoch.

## Discovery
Zero-config host finding: the 3DS broadcasts an encrypted UDP probe (port 41337); a host holding the same PSK replies unicast with its TCP port. Discovery datagrams use their own AAD domain (`3dsendai-dsc-v1`) so they can never be spliced into the TCP stream. Removes the hardcoded `SERVER_HOST` requirement (R21).

## Session backend
The host-side component that sources terminal sessions for the device — enumerates them, streams a focused session's output down, delivers keystrokes up, and raises alerts. tmux (via the tmux bridge) is the default; alternatives (e.g. herdr) implement the same bridge surface, and the device never learns which backend it is driving.

## tmux bridge
The host acting as a client of the user's own tmux server, streaming a session's live pane to the 3DS and delivering the device's keystrokes back into it. 3dsendai attaches to sessions the user created with plain `tmux new -s <name>`; it never spawns or manages tmux. Preferred mechanism is tmux control mode (`tmux -CC`). The default session backend; the herdr bridge is its sibling behind the same interface. Spec: the tmux-terminal requirements doc.

## herdr bridge
The herdr session backend (plan-005): the host attaches to the user's running herdr daemon as an external socket client — never spawning or managing herdr — and maps panes to device sessions. Structure and agent-state events ride the api socket (NDJSON); the focused pane's bytes, input, and resize ride a per-pane `herdr terminal session control` channel whose full first frame doubles as the repaint boundary. Alerts map herdr's semantic agent states onto the existing taxonomy (`blocked` → attention, `done` → likely_done, pane exit → session_ended) and are re-derived on device attach so nothing is lost to a sleeping device. Requires herdr ≥ 0.7.2; wire facts and fixtures: host/test/fixtures/herdr/.

## Terminal mode
The device's primary mode: the 3DS renders a live terminal (VT/ANSI) for a focused tmux session on the top screen and sends real keystrokes, with a bottom-screen control strip and physical buttons for navigation. The raw path — whatever runs in the pane is opaque to the host, no per-agent event parsing.

## Macropad mode
The device's secondary, toggleable mode: the bottom screen becomes a grid of configurable quick-action buttons that fire predefined keystrokes/strings (approve, reject, common commands) into the focused session. The desk-side "Stream Deck" for a run watched on the monitor.
