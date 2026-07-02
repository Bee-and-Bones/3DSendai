# tmux control-mode fixtures (S3 spike findings)

Captured from real `tmux 3.7b` on macOS. These drive the `control-mode.ts` parser
tests (U31). Regenerate with the scratch capture harness (`pty.fork()` + `tmux -L
<sock> -CC attach`).

## S3 go/no-go: GO, with one plan correction

**Corrected KTD1 — a PTY is required.** `tmux -CC` calls `tcgetattr` on its
stdio and exits (`tcgetattr failed: Operation not supported on socket`) when given
plain pipes. `script` fails the same way. So control mode is *not* drivable over a
bare `Bun.spawn` pipe — the client needs a controlling terminal, exactly why iTerm2
runs `tmux -CC` under a pty.

Bun exposes no native pty API, and `node-pty` is unreliable under Bun. The working,
portable allocator is a small **Python `pty.fork()` helper** the host spawns via
`Bun.spawn` (Python 3 is present on macOS/Linux): the child `execvp`s `tmux -CC`
with the slave pty as its controlling terminal; the parent relays the master fd to
the host over ordinary pipes. `pty.spawn()` does NOT work (its stdin-EOF copy loop
drops output) — use manual `pty.fork()` + `select` on the master. U31 wires this as
`host/src/tmux/pty.py` (or equivalent) driven from `bridge.ts`.

## Wire protocol confirmed

- **Lines are CRLF-terminated** (`\r\n`). Split on `\r?\n`.
- **Command replies are framed**: `%begin <ts> <cmd-num> <flags>` ... reply lines
  ... `%end <ts> <cmd-num> <flags>` (or `%error ...`). Match replies by cmd-num.
- **Pane output**: `%output %<pane-id> <data>` where `<data>` is the raw terminal
  byte stream **backslash-octal-escaped** (`\033` = ESC, `\015` = CR, `\010` = BS,
  `\\` = backslash). Byte-verified: the four literal chars `\`,`0`,`3`,`3`. The
  parser unescapes `\ooo` (1-3 octal digits) and `\\` back to raw bytes.
- **Notifications** seen: `%session-changed $<id> <name>`, `%session-window-changed`,
  `%window-add @<id>`, `%window-renamed`, `%unlinked-window-close`, `%layout-change`,
  `%exit` (client leaving). `%bell` fires only for background windows with
  `monitor-bell on`; a foreground BEL simply appears as `\007` inside `%output`, so
  the host detects bells from BOTH `%bell` notifications and `\007` in decoded output.
- **Enumeration** (outside the stream): `tmux -L <sock> list-sessions -F
  '#{session_name}:#{session_id}'` and `list-panes -F '#{pane_id}:#{pane_dead}'`.
- **Input**: write `send-keys -t <pane> -H <hexbytes>` (or literal) as a command line
  on the master. **Resync on attach**: `capture-pane -t <pane> -e -p`.

## Throughput note (KTD4)

`%output` is per-write and octal-escaping ~doubles the control-channel size; our
device re-encode to hex doubles again. For coding-agent output volume over LAN this
is acceptable — keep hex-in-JSON for v1. The raw-binary frame variant stays the
escape hatch if a real workload shows strain.

## Files

- `attach-output-window-session.raw` — a full attach: `%begin/%end` blocks,
  `%session-changed`, an escaped `%output` (SGR color), `%window-add/renamed/close`,
  `%exit`.
