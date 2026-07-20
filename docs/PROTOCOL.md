# AgentBus wire protocol

The contract between the 3DS client (C) and the host (Bun/TS). The two ends
share no runtime code — the generated constants (`bun run codegen`), the golden
vectors (`protocol/test/golden/`), and the cross-library KATs
(`protocol/test/*.test.ts` ⇄ `client/test/*_test.c`) keep them in sync.

All multi-byte integers are **big-endian**. The host **listens** on TCP
(default **4791**); the 3DS **connects**.

## L3 — AgentBus frame (the plaintext)

```
[u32 length BE][u8 type][u32 session_id BE][canonical JSON payload]
```

`length` counts everything after itself. Message type codes are single-sourced
in `protocol/codegen/message-types.source.ts` and generated into both the TS
module and `client/source/protocol.h`. Payload is canonical JSON (recursively
sorted keys, no whitespace) so golden vectors are byte-exact.

## Secure transport (active when both ends share a PSK)

Crypto: **XChaCha20-Poly1305 AEAD** — libsodium on the host, Monocypher 4.0.2
on the 3DS. Keyed by one **32-byte pre-shared key**, exchanged out-of-band as
64 lowercase hex chars (`SENDAI_PSK` env on the host, `PAIR_PSK` in the client's
`config.h`). When no PSK is configured both ends speak plaintext with token
auth — the dev/loopback mode.

### Record layout

Each plaintext AgentBus frame is sealed as one record, carried on TCP under an
outer length prefix:

```
[u32 len BE] [ nonce(24) ‖ ciphertext(N) ‖ mac(16) ]     len = 24 + N + 16
```

- Nonce: 24 random bytes per record (192-bit nonce makes random safe; no
  counter state to desync).
- MAC: 16-byte Poly1305 tag. libsodium appends it to the ciphertext,
  Monocypher emits it separately — reconciled in the wrappers; the wire is
  identical.
- Receivers enforce a hard length cap (`MAX_SECURE_RECORD`, 16 KiB) **before**
  buffering; the 3DS receive buffer is 16 KiB.

### AAD (authenticated, never transmitted)

```
context(12) ‖ dir(1) ‖ epoch(8 BE) ‖ seq(8 BE)      = 29 bytes
```

- `context`: `"3dsendai-msg-v1"` for TCP records, `"3dsendai-dsc-v1"` for discovery
  datagrams — domain separation, so a captured discovery frame can never be
  spliced into a TCP stream or vice versa.
- `dir`: `0x00` host→device, `0x01` device→host — blocks reflection.
- `epoch`: 8 random bytes the host mints per TCP connection and sends as the
  **first 8 cleartext bytes** after accept. Both ends bind it into every AAD —
  defeats cross-session replay. `0` on the plaintext/dev path.
- `seq`: per-direction monotonic counter, starts at 0, +1 per record sent.
  The receiver decrypts against its **own** expected counter — no sequence
  number travels on the wire, so any replay, reorder, or splice fails the tag.

A record that fails to open (wrong key, tamper, wrong seq/dir/epoch/context)
**closes the connection**. Reconnect is the recovery path; the app-layer ATTACH
cursor replays missed output (durable sessions are untouched by transport
crypto).

With a PSK active, the AEAD tag is the authenticator — the first record that
unlocks proves key possession. The ATTACH token remains as the app-layer
session handshake and belt-and-suspenders auth.

## Discovery (UDP, zero-config)

Default UDP port **41337** (`SENDAI_DISCOVERY_PORT`). Requires a PSK (there is
nothing to authenticate a reply with otherwise). Datagram layout:

```
MAGIC "ag3n"(4) ‖ TYPE(1) ‖ sealed record (AAD context "3dsendai-dsc-v1", epoch 0, seq 0)
```

1. **3DS → broadcast** `255.255.255.255:41337`, `TYPE=0x01` (probe). Record
   plaintext = 8 random challenge bytes; AAD dir = `0x01`. Retries a few times
   before falling back to the compiled-in `SERVER_HOST`.
2. **Host** listens on 41337; on a probe that unlocks with the PSK it replies
   **unicast** to the sender, `TYPE=0x02`. Record plaintext =
   `challenge(8) ‖ tcpPort(2 BE)`.
3. **3DS** accepts the first reply that unlocks and whose challenge matches;
   it learns the host IP from the datagram source address and connects.

Wrong-key or garbage datagrams are ignored — a passive scanner gets nothing,
and a wrong key can't forge a reply.

## Terminal mode (plan-003, backend seam plan-005, agent board plan-001)

In terminal mode (`SENDAI_BACKEND=agents|tmux|herdr`; unset defaults to
`herdr`, `SENDAI_TMUX=1` is the tmux alias) the host is a client of the user's
own terminal multiplexer and bridges its sessions to the device over the same
sealed transport — four added frame types, all ordinary sealed records. The
backend is a host-launch choice; the wire contract and the device are
identical for every backend:

| type | dir | payload | meaning |
|---|---|---|---|
| `TERMINAL_DATA` (11) | host→device | `{sessionId, hex}` | raw terminal bytes, hex-encoded, chunked under the record cap |
| `ALERT_SIGNAL` (12) | host→device | `{sessionId, class}` | `attention` \| `session_ended` \| `likely_done` |
| `KEYSTROKE` (72) | device→host | `{sessionId, hex}` | raw key bytes to inject into the focused session |
| `MACRO_INTENT` (70) | device→host | `{intent:"approve"\|"reject"}` | watched-screen approval on a **herdr** agent (plan-001 U5); dormant on other backends |

Backend-agnostic contract properties (every backend upholds all of these):

- **Session enumeration** uses repeated `SESSION_STATE` frames (one per
  backend session); `SESSION_LIST` is a clear/boundary marker. The device's
  naive JSON scanner can't parse arrays, so the board is delivered one object
  per frame.
- **Agent-board fields** (U3/plan-001, strictly additive): `SessionSummary`
  carries optional `kind`, `agentName`, `title`, and `workspace` strings, plus
  an `unknown` `status` value for unrecognized backend states. All four are
  optional and old clients ignore them — `agent` keeps its decorated label as
  the picker's primary display string, so pre-refactor labels are unchanged.
  `kind` is the stable agent identifier (`codex`, `claude`, `cursor`, `omp`,
  `opencode`, …); `agentName` is the short display name (`display_agent` ??
  `agent` at the herdr backend); `title` is the task title; `workspace` is a
  workspace label. All four pass the host's control-byte-stripping
  (`sanitizeLabel`) before emission, since they feed the approval surface.
  tmux/agents rows render sparsely (name + status only — no kind/title/workspace).
- **Terminal bytes** are hex inside the JSON payload (reuses the C hex decoder
  and the golden-vector discipline); the host chunks so each sealed record
  stays under the 16 KB cap. A raw-binary frame variant is the escape hatch if
  throughput ever demands it.
- **Reconnect** resyncs from the backend's own buffer, so the backend owns
  scrollback and persistence — the host keeps no terminal ring.

`MACRO_INTENT`'s herdr-mode meaning (U5/plan-001) — the board's Accept/Deny
for a blocked agent: payload is `{"intent":"approve"}` or
`{"intent":"reject"}`; the frame header's `session_id` targets the **cursor
row directly** — the same session-targeting idiom `KEYSTROKE` uses —
independent of which session is focused, so approving one agent never depends
on (or changes) which pane is streaming. The herdr bridge revalidates against
a **fresh** snapshot before sending anything (the tap-to-snapshot window is
closed; the snapshot-to-send window is not — herdr has no atomic
approve-iff-blocked primitive, an accepted watched-screen-semantics residual).
On a passing gate it issues one `pane.send_keys` request with the per-kind
sequence (`host/src/herdr/approvals.ts`); on a failing gate it sends nothing
and emits `ERROR` with one of:

- `approval unavailable: stale agent` — the pane is gone from the fresh snapshot
- `approval unavailable: not blocked` — the agent unblocked between tap and snapshot
- `approval unavailable: no approval mapping for <kind>` — the kind isn't in
  the compiled five-kind allowlist (`codex`, `cursor`, `claude`, `omp`, `opencode`)
- `approval unavailable: approvals need herdr >= 0.7.3` — the daemon rejected
  `pane.send_keys` as an unknown method (a pre-0.7.3 daemon; protocol 16 is
  shared, so this is the only detection point)
- `approval failed: <herdr error>` — any other herdr-call failure (snapshot
  fetch, or `send_keys` rejected for another reason)

Other backends (tmux, agents) never receive `MACRO_INTENT` traffic that maps
to anything — the frame stays dormant outside herdr mode. `MACRO_INTENT` is
distinct from the structured `APPROVAL_REQUEST`/`APPROVAL_RESPONSE` tier:
`blocked` status carries no request identity, so this is a watched-screen
convenience over a screen the user can see, not authorization evidence
(ported from AgentSlate's own research — see `host/src/herdr/AGENTSLATE-PORT.md`).

Backend instances:

- **herdr** (plan-005, multi-session + board plan-001; **default**): the herdr
  api socket (NDJSON) per discovered session for enumeration and events — every
  running session is discovered (`herdr session list --json`, U2) and
  flattened into one board unless `SENDAI_HERDR_SESSION`/`SENDAI_HERDR_SOCKET`
  pins a single explicit target. Terminal channels are **lazy**: no channel
  opens and no pane is focused at attach — only `FOCUS_SESSION` opens a
  per-pane `herdr terminal session control` channel (against the right
  daemon), whose full first frame is the resync/repaint boundary; a device
  that only glances at the board never takeovers a desktop pane. Alerts come
  from herdr's semantic agent states (`blocked`→attention, `done`→likely_done,
  pane exit→session_ended), now per session, re-derived on device attach so
  alerts fired into a sleeping device aren't lost. Each discovered session
  bootstraps independently — one stale daemon emits one `ERROR` naming it
  while the healthy subset comes up. OSC sequences are stripped host-side (the
  device's VT emulator does not parse OSC).
- **tmux** (plan-003; via `SENDAI_BACKEND=tmux`): control mode (`tmux -CC`, run
  under a small Python pty helper because `tmux -CC` needs a controlling tty);
  sessions map to tmux sessions, keystrokes inject via `send-keys`, resync via
  `capture-pane`, alerts from bells + activity-then-idle heuristics.

Everything is sealed exactly like the rest of AgentBus: terminal output and
keystrokes never cross the wire in cleartext (verified per backend by the
U38 tmux and plan-005 U6 herdr e2e suites).

## Threat model / non-goals

- The PSK at rest is cleartext (host env, client `config.h`). The threat model
  is a network eavesdropper/active attacker, not device theft.
- No forward secrecy: a leaked PSK decrypts captured traffic. Rotate by
  changing both ends.
- Flood/DoS resistance is out of scope; the AEAD gate only guarantees that
  unauthenticated peers can't drive the host or read traffic.
- **Anti-replay is asymmetric.** The device→host direction (the one that drives
  agent actions) is fully protected: the host mints the epoch, so a replayed or
  cross-session device→host record fails authentication. The host→device
  direction is display-only and slightly weaker — an active MITM without the
  PSK can feed the device a *replayed* older host→device session (hand it the
  captured epoch, replay the captured `DIR_DOWN` records). They cannot forge or
  read anything (no PSK), only replay stale output the device already saw. A
  device-contributed handshake nonce would close this; it's deferred because
  the exposed, action-executing direction is already sound.
- **The client connect path is blocking.** `ab_net_connect` (and the 8-byte
  epoch read) run on the render thread with bounded timeouts; a dead or
  half-open host stalls the UI for up to a few seconds before the reconnect
  loop retries. A fully non-blocking connect is future work.
