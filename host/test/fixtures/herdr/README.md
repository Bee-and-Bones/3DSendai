# herdr fixtures (plan-005 U1, refreshed plan-001 U1)

Captured from a real herdr daemon; later units build parsers from these files,
never from memory of the docs (fixture-first discipline).

## Version pin

- **herdr 0.7.3** (stable channel, released 2026-07-13), **socket protocol 16**,
  API `schema_version` 1.
- Captured **2026-07-20** against scratch named sessions (`herdr --session
  3dsendai-spike server`, plus `3dsendai-spike2` for the two-running session
  list) on macOS — never the user's default socket
  (`~/.config/herdr/herdr.sock`), which stayed stopped throughout.
- **0.7.4** (2026-07-15) is the latest stable as of capture; only unstable
  preview builds are newer. 0.7.3 → 0.7.4 was reviewed and changes nothing this
  plan depends on, so the fixtures are pinned at the installed 0.7.3.
- herdr moves fast (protocol 14 → 16 in ~3 weeks earlier in 0.7.x; 16 has held
  across 0.7.2/0.7.3/0.7.4). If fixtures are refreshed against a newer daemon,
  update this pin and re-run the U3/U4 suites.

## File format

Each `.ndjson` file is one captured flow. Lines are `SEND <json>` (host →
daemon) and `RECV <json>` (daemon → host), in wire order. `RECV(tag)` in the
contention file distinguishes concurrent client processes. Terminal-channel
files capture the stdio of `herdr terminal session control` (stdin commands as
SEND, stdout records as RECV); frame `bytes` fields are base64 transport
(`encoding:"ansi"` describes the decoded *content*, not the transport), as on
the wire. `cli-session-list.txt` uses a `CMD <argv>` / `OUT <json>` convention
(one CMD/OUT pair per invocation) for CLI stdout captures.

- `socket-bootstrap-empty.ndjson` — ping, empty `session.snapshot`, error
  responses: unknown method (`invalid_request`), `pane_not_found` for
  `pane.read` and `pane.send_input`.
- `socket-setup.ndjson` — `workspace.create` + `pane.split` responses.
- `socket-snapshot-populated.ndjson` — populated snapshot (note top-level
  `focused_*` ids) + `pane.list`.
- `socket-snapshot-agents.ndjson` — populated snapshot with a non-empty
  top-level `agents[]` (three panes reported via `pane.report_agent` +
  `pane.report_metadata`: `working`/`idle`/`blocked`) and `workspaces[]`. Each
  `agents[]` entry carries `pane_id`, `terminal_id`, `workspace_id`, `tab_id`,
  `agent`, `agent_status`, `display_agent`, `title`, `cwd`, `foreground_cwd`,
  `focused`, `revision`. A fourth pane with no reported agent stays in `panes[]`
  as `agent_status:"unknown"` and is **absent from `agents[]`** — `agents[]`
  lists only panes with a detected/reported agent.
- `socket-subscribe-events.ndjson` — one `events.subscribe` carrying global
  lifecycle types plus per-pane `pane.agent_status_changed` subs; the
  subscription ack; the initial-state replay (existing panes re-delivered as
  `pane_created`/`pane_focused`); live `pane.agent_status_changed` pushes
  (blocked → working → idle) and a `pane_exited` push.
- `socket-report-agent.ndjson` — the `pane.report_agent` calls that produced
  those pushes (the live test's trigger vocabulary).
- `socket-send-input.ndjson` — `pane.send_input` text-only, keys-only, mixed
  text+keys, and the atomic `invalid_key` rejection of `ctrl-c`.
- `socket-send-keys.ndjson` — `pane.send_keys` `{pane_id, keys:[…]}` happy path
  and rejections. Probes the key-name vocabulary U5 depends on (see the
  key-name table below): `enter`, `y`, `n`, `esc`, `esc`+`enter` in one
  request, `shift+tab`, `Y`, `tab`, `space` all accepted; `ctrl-c` rejected
  (`invalid_key`); an unknown pane rejected (`pane_not_found`).
- `cli-session-list.txt` — `herdr session list --json` for a one-running board
  (default stopped) and a two-running board. Entry fields: `default`, `name`,
  `running`, `session_dir`, `socket_path`. Ordering is default-first, then
  alphabetical.
- `terminal-control-frames.ndjson` — a control channel on a pane: initial
  `terminal.frame` (`full:true`, 50x24), input echo deltas (`full:false`),
  `terminal.resize` → immediate `full:true` frame at 40x20,
  `terminal.release` → `terminal.closed` (`reason:"detached"`).
- `terminal-control-contention.ndjson` — second controller without
  `--takeover` is refused (`terminal.closed`, reason begins `terminal attach
  failed: … already has an attached client; retry with --takeover`); third
  with `--takeover` wins and the first gets `terminal.closed`
  (`reason:"terminal attach taken over"`).

## Scrub note

Captures were made against panes neutralized before any frame capture
(`cwd /`, `exec env PS1='$ ' sh`, `clear`), so no usernames, real paths, or
host names appear in socket payloads or decoded frame bytes (verified by
decoding every base64 `bytes` field). Random terminal ids were normalized to
`term_00000000000001`-style stable values (consistently across files: pane p1 →
`…002`, p2 → `…003`, p3 → `…001`, p4 → `…004`, matching the historical mapping).
Real home paths in `cli-session-list.txt` (`/Users/<user>` in `session_dir` /
`socket_path`) were normalized to `/home/user`. No other bytes were altered.

Not capturable from a real daemon and therefore synthesized in tests, shaped
on these fixtures: a `done` agent status (`pane.report_agent` accepts only
idle|working|blocked|unknown — the input enum excludes `done`, unchanged from
0.7.2; `done` is integration-derived, surfaced only by a real agent adapter)
and a protocol-mismatch `ping` (the pinned daemon is protocol 16). The
`AgentStatus` *output* enum does include `done`; only the report *input* omits
it.

## Observed wire facts the docs don't state (or state wrongly)

1. **One request per connection.** The api socket answers the first request
   and immediately closes (re-verified at 0.7.3: a second request pipelined on
   the same connection is never answered — the connection closes after the
   first response). The docs' "persistent connection with multiple requests" is
   not what herdr does. `events.subscribe` is the exception: its connection
   stays open and streams pushes — but exactly one subscribe request per
   connection (a second `events.subscribe` on the same connection gets no
   response and the connection is dropped; re-verified at 0.7.3).
2. **Request `id` is a string.** Integer ids are rejected (`invalid_request`).
   Pushes carry no `id`.
3. **Event-name shape is mixed.** Per-pane subscribed pushes use dotted
   names (`pane.agent_status_changed`); global lifecycle pushes use
   underscores (`pane_created`, `pane_focused`, `pane_exited`,
   `pane_agent_detected`). Discriminate on the `event` key. (Re-verified at
   0.7.3 — unchanged.)
4. **Subscribe replays current state** as synthetic `pane_created` /
   `pane_focused` events, filtered by the subscription's requested types
   (a `pane.exited`-only subscribe replays already-exited panes as
   `pane_exited` and nothing else).
5. **The daemon dedupes same-state agent reports** (blocked → blocked pushes
   nothing; each real transition pushes once).
6. **`pane.send_input` `{text, keys}` applies text first, then keys**, and
   key validation is atomic (`invalid_key` rejects the whole call).
   `ctrl-c` is not a key name; raw control bytes go via the terminal
   control channel instead.
7. **`pane.send_keys` `{pane_id, keys:[string]}`** (protocol 16, present in
   both 0.7.2 and 0.7.3) takes free-form key-name strings and validates them
   the same way `send_input`'s `keys` does. **Key-name validity at 0.7.3
   (`socket-send-keys.ndjson`):**

   | key(s)             | result                      |
   | ------------------ | --------------------------- |
   | `["enter"]`        | ok                          |
   | `["y"]`            | ok                          |
   | `["n"]`            | ok                          |
   | `["esc"]`          | ok                          |
   | `["esc","enter"]`  | ok (multi-key, one request) |
   | `["shift+tab"]`    | ok                          |
   | `["Y"]`            | ok                          |
   | `["tab"]`          | ok                          |
   | `["space"]`        | ok                          |
   | `["ctrl-c"]`       | rejected `invalid_key`      |
   | unknown pane       | rejected `pane_not_found`   |

   **Single-character key names (`y`, `n`, `Y`) ARE valid at 0.7.3.** U5's
   approval keymaps (`y`/`n`/`esc`/`enter`, multi-key `["esc","enter"]`,
   `shift+tab`) can send `pane.send_keys` directly — the `send_input {text}`
   fallback is **not** needed at 0.7.3. `ctrl-c`-style control keys remain the
   only rejected shape (route raw control bytes through the terminal channel).
8. **Terminal control channel** (`herdr terminal session control <pane>
   [--takeover] --cols C --rows R`): pipes-only NDJSON, no PTY needed. stdout
   records `terminal.frame` `{seq, full, width, height, encoding:"ansi",
   bytes}` (`bytes` is base64 transport; `encoding` labels the decoded content)
   and `terminal.closed` `{reason}`; stdin commands `terminal.input`
   `{bytes, encoding:"base64"}`, `terminal.resize` `{cols, rows}`,
   `terminal.release`. Frames are rendered screen-state deltas, not raw
   scrollback; `full:true` on connect and after resize. One controller per
   terminal with `--takeover` preemption. Frames open with OSC 8
   (`\x1b]8;;\x1b\\`) and DECSET 2026, which the 3DS `term.c` must not see raw
   — the bridge strips OSC sequences host-side (`stripOsc`).

### Default-session addressing (U4 spawn rule)

`herdr session list --json` lists the default session as `{name:"default",
default:true, running:false, session_dir:"~/.config/herdr",
socket_path:"~/.config/herdr/herdr.sock"}` — its socket is the **top-level**
`herdr.sock`, not `sessions/default/herdr.sock`.

A session-qualified CLI invocation reaches the default session via
**`--session default`**, which resolves to that top-level socket (confirmed
without starting the daemon: `herdr --session default status` printed
`socket: ~/.config/herdr/herdr.sock` and returned `ConnectionRefused` against
the stopped default — it did **not** create a `sessions/default/` dir or spawn a
server). **Rule U4 follows:** address every session — default included —
uniformly with `--session <name>`; the CLI special-cases the literal name
`default` to the top-level socket. Equivalently, dial the `socket_path` from
`session list --json` directly. (Determined from the CLI surface;
`terminal session control` uses the same global `--session` resolution, so the
rule carries to channel spawns. Residual uncertainty: not exercised against a
live default-session control channel, since the default daemon was kept
stopped.)

### Seen-on-refocus (0.7.3 release note)

The 0.7.3 notes claim: *"Re-focusing an already-focused done agent or pane
through the socket API now marks it seen instead of leaving stale done status in
API responses."* This is **not live-reproducible from the socket** because
`done` is not reportable via `pane.report_agent`. Observed live for a
**blocked** pane (refocus probe on the `socket-snapshot-agents` board):
`pane.focus` returns a `pane_info` result and sets `focused:true`, but
`agent_status` stays `blocked` across the first focus **and** a redundant
re-focus of the already-focused pane — i.e. focus alone does **not** clear an
active state. The done-clearing behavior applies specifically to the terminal
`done` status and is carried as a release-note fact, not a captured one; keep
`done` synthesized in tests. Consequence for U4: the bridge must not expect
`pane.focus` to clear `blocked`, and (per U4) goes lazy on focus anyway.

## 0.7.2 → 0.7.3 deltas that affect the bridge

- **`ping.version` / `snapshot.version` string** is now `"0.7.3"` (was
  `"0.7.2"`). `protocol` stays `16`; `capabilities` unchanged
  (`live_handoff:true`, `detached_server_daemon:false`). The socket suite's one
  hardcoded version assertion was updated; nothing else in the parser keys off
  the version string.
- **No wire-shape changes.** The `invalid_request` method enum, error codes
  (`pane_not_found`, `invalid_key`), snapshot/pane/agent field shapes, event
  naming, connection model, `send_keys`/`send_input` key validation, and the
  terminal-control frame/close records are all byte-identical to 0.7.2 after
  id/path normalization (several recaptured fixtures diff to zero). The
  `terminal.frame` `encoding:"ansi"` label was already present at 0.7.2 (it is
  the content-type, not a transport change).
- **New behavior, no new wire fields:** the seen-on-refocus fix (above) changes
  daemon-internal `done` bookkeeping, observable only through a real agent
  integration — no new response field at 0.7.3. `terminal_title_stripped` still
  does not exist at 0.7.3 (U4 tolerates it as an absent optional).

## U1 decision record (plan-005 decision rule)

The plan's three-way call assumed the only live-output paths were (a)
PTY-attach to the whole herdr TUI or (b) revision-polled `pane.read`, with
(c) halt if focus was global AND snapshots daemon-sized. herdr 0.7.2
(released the day of the original spike) shipped a purpose-built third path:
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
