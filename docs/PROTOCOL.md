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

## Terminal mode (plan-003)

When the host runs in **tmux mode** (`SENDAI_TMUX=1`), it is a client of the
user's own tmux server (control mode, `tmux -CC`, run under a small Python pty
helper because `tmux -CC` needs a controlling tty). It bridges tmux sessions to
the device over the same sealed transport — three added frame types, all
ordinary sealed records:

| type | dir | payload | meaning |
|---|---|---|---|
| `TERMINAL_DATA` (11) | host→device | `{sessionId, hex}` | raw pane bytes, hex-encoded, chunked under the record cap |
| `ALERT_SIGNAL` (12) | host→device | `{sessionId, class}` | `attention` \| `session_ended` \| `likely_done` |
| `KEYSTROKE` (72) | device→host | `{sessionId, hex}` | raw key bytes to inject via tmux `send-keys` |

- **Session enumeration** uses repeated `SESSION_STATE` frames (one per tmux
  session); `SESSION_LIST` is a clear/boundary marker. The device's naive JSON
  scanner can't parse arrays, so the board is delivered one object per frame.
- **Pane bytes** are hex inside the JSON payload (reuses the C hex decoder and
  the golden-vector discipline); the host chunks so each sealed record stays
  under the 16 KB cap. A raw-binary frame variant is the escape hatch if
  throughput ever demands it.
- **Reconnect** resyncs to tmux's own buffer (`capture-pane`), so tmux owns
  scrollback and persistence — the host keeps no terminal ring.
- Everything is sealed exactly like the rest of AgentBus: terminal output and
  keystrokes never cross the wire in cleartext (verified by the U38 e2e).

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
