# herdr fixtures (plan-005 U1)

Captured from a real herdr daemon; later units build parsers from these files,
never from memory of the docs (fixture-first discipline).

## Version pin

- **herdr 0.7.2** (stable channel, released 2026-07-07), **socket protocol 16**,
  API `schema_version` 1.
- Captured 2026-07-07 against a scratch named session (`herdr --session
  3dsendai-spike server`) on macOS — never the user's default socket.
- herdr moves fast (14 → 16 in ~3 weeks). If fixtures are refreshed against a
  newer daemon, update this pin and re-run the U3/U4 suites.

## File format

Each `.ndjson` file is one captured flow. Lines are `SEND <json>` (host →
daemon) and `RECV <json>` (daemon → host), in wire order. `RECV(tag)` in the
contention file distinguishes concurrent client processes. Terminal-channel
files capture the stdio of `herdr terminal session control` (stdin commands as
SEND, stdout records as RECV); `bytes` fields are base64 ANSI, as on the wire.

- `socket-bootstrap-empty.ndjson` — ping, empty `session.snapshot`, error
  responses: unknown method (`invalid_request`), `pane_not_found` for
  `pane.read` and `pane.send_input`.
- `socket-setup.ndjson` — `workspace.create` + `pane.split` responses.
- `socket-snapshot-populated.ndjson` — populated snapshot (note top-level
  `focused_*` ids) + `pane.list`.
- `socket-subscribe-events.ndjson` — one `events.subscribe` carrying global
  lifecycle types plus per-pane `pane.agent_status_changed` subs; the
  subscription ack; the initial-state replay (existing panes re-delivered as
  `pane_created`/`pane_focused`); live `pane.agent_status_changed` pushes
  (blocked → working → idle) and a `pane_exited` push.
- `socket-report-agent.ndjson` — the `pane.report_agent` calls that produced
  those pushes (the live test's trigger vocabulary).
- `socket-send-input.ndjson` — `pane.send_input` text-only, keys-only, mixed
  text+keys, and the atomic `invalid_key` rejection of `ctrl-c`.
- `terminal-control-frames.ndjson` — a control channel on a pane: initial
  `terminal.frame` (`full:true`, 50x24), input echo deltas (`full:false`),
  `terminal.resize` → immediate `full:true` frame at 40x20,
  `terminal.release` → `terminal.closed` (`reason:"detached"`).
- `terminal-control-contention.ndjson` — second controller without
  `--takeover` is refused (`terminal.closed` with "already has an attached
  client"); third with `--takeover` wins and the first gets
  `terminal.closed` (`reason:"terminal attach taken over"`).

## Scrub note

Captures were made against panes neutralized before any frame capture
(`cwd /`, `exec env PS1='$ ' sh`, `clear`), so no usernames, real paths, or
host names appear in socket payloads or decoded frame bytes (verified by
decoding every base64 `bytes` field). Random terminal ids were normalized to
`term_00000000000001`-style stable values (consistently across files). No
other bytes were altered.

Not capturable from a real daemon and therefore synthesized in tests, shaped
on these fixtures: a `done` agent status (`pane.report_agent` accepts only
idle|working|blocked|unknown; `done` is integration-derived) and a
protocol-mismatch `ping` (the pinned daemon is protocol 16).

## Observed wire facts the docs don't state (or state wrongly)

1. **One request per connection.** The api socket answers the first request
   and immediately closes (verified: close arrives 0 ms after the first
   response; a second pipelined or sequential request is never answered).
   The docs' "persistent connection with multiple requests" is not what
   0.7.2 does. `events.subscribe` is the exception: its connection stays
   open and streams pushes — but exactly one subscribe request per
   connection (a second one gets the connection dropped with no response).
2. **Request `id` is a string.** Integer ids are rejected
   (`invalid_request`).
3. **Event-name shape is mixed.** Per-pane subscribed pushes use dotted
   names (`pane.agent_status_changed`); global lifecycle pushes use
   underscores (`pane_created`, `pane_exited`, `pane_agent_detected`).
   Pushes carry no `id`; discriminate on the `event` key.
4. **Subscribe replays current state** as synthetic `pane_created` /
   `pane_focused` events (including already-exited panes' `pane_exited`).
5. **The daemon dedupes same-state agent reports** (blocked → blocked pushes
   nothing; each real transition pushes once).
6. **`pane.send_input` `{text, keys}` applies text first, then keys**, and
   key validation is atomic (`invalid_key` rejects the whole call).
   `ctrl-c` is not a key name; raw control bytes go via the terminal
   control channel instead.
7. **Terminal control channel** (`herdr terminal session control <pane>
   [--takeover] --cols C --rows R`, added in 0.7.2): pipes-only NDJSON, no
   PTY needed. stdout records `terminal.frame` `{seq, full, width, height,
   encoding:"base64", bytes}` and `terminal.closed` `{reason}`; stdin
   commands `terminal.input` `{bytes, encoding}`, `terminal.resize`
   `{cols, rows}`, `terminal.release`. Frames are rendered screen-state
   deltas, not raw scrollback (a 20k-line burst collapses to ~3 frames);
   `full:true` on connect and after resize. Invalid stdin commands are
   non-fatal stderr warnings. The controller owns the pane's real PTY
   winsize (`stty size` follows `terminal.resize`); concurrent observers
   render at their own sizes; one controller per terminal with `--takeover`
   preemption. Frames open with OSC 8 (`\x1b]8;;\x1b\\`) and DECSET 2026,
   which the 3DS `term.c` must not see raw (it spills OSC bodies as text) —
   the bridge strips OSC sequences host-side.

## U1 decision record (plan-005 decision rule)

The plan's three-way call assumed the only live-output paths were (a)
PTY-attach to the whole herdr TUI or (b) revision-polled `pane.read`, with
(c) halt if focus was global AND snapshots daemon-sized. herdr 0.7.2
(released the day of this spike) shipped a purpose-built third path:
per-pane terminal control channels. Evidence above; consequences against the
decision rule's concerns:

- **Focus contention: gone.** The bridge never touches herdr focus/zoom;
  each pane streams independently. The desk TUI and the bridge coexist
  (verified with a live TUI client attached during control) — no shared
  focus, no chrome, nothing to zoom.
- **Sizing: controller-owned.** `terminal.resize` sets the pane's real PTY
  winsize (device-size reflow, R4) while the desk client keeps rendering at
  its own grid. Same single-PTY reality as the tmux backend's
  `refresh-client -C`.
- **Latency/throughput:** input-echo round-trip ~20 ms (bar was ~150 ms);
  output is screen-state deltas, bounded regardless of pane spam.

**Decision: control-channel primary** — `herdr terminal session control`
per focused pane (spawned over plain pipes, `--takeover`, device-sized),
device keystroke hex forwarded verbatim as base64 `terminal.input` (no
key-name mapping), `terminal.resize` for CLIENT_SIZE, channel restart as the
repaint boundary (`full:true` first frame) for focus switch and resync.
Socket stays for enumeration, subscriptions, and alerts. This is outcome (a)
in spirit — a live push stream with per-client sizing — via a mechanism the
plan couldn't have named; neither the (b) fallback nor the (c) halt
condition applies. `pane.read` polling remains the documented fallback if
upstream removes the channel.
