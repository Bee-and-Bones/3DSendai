#!/usr/bin/env python3
# U31 tmux control-mode PTY helper (S3 finding: KTD1 corrected).
#
# `tmux -CC` calls tcgetattr on its stdio and exits ("Operation not supported on
# socket") when handed bare pipes, so control mode is NOT drivable over a plain
# Bun.spawn pipe. Bun has no native pty API and node-pty is Bun-unreliable, so the
# host spawns this small Python helper instead: we allocate a real pty with
# pty.fork(), exec tmux in the child (with the slave as its controlling terminal),
# and relay the master fd <-> our stdio over ordinary pipes for the host to speak
# control mode across.
#
# pty.spawn() does NOT work here: its internal stdin-EOF copy loop drops output.
# We do the relay by hand with a select loop on the master fd.
#
# Named tmux-pty.py (not pty.py) so python's sys.path[0] insert doesn't shadow
# the stdlib `pty` module this file imports.
#
# Usage: tmux-pty.py tmux -L <sock> -CC attach -t <session>
#   argv[1:] is the full command to exec in the pty child.
#
# U2 (plan-004): the pty starts at the device's terminal size so tmux never
# renders at its 80-col default and wraps output twice. SENDAI_PTY_COLS /
# SENDAI_PTY_ROWS override the 50x24 default; the winsize ioctl runs in the
# child on the slave (fd 0) before exec, so there is no race with tmux startup.

import fcntl
import os
import pty
import select
import struct
import sys
import termios


def _env_dim(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("pty.py: missing command\n")
        return 2

    cols = _env_dim("SENDAI_PTY_COLS", 50)
    rows = _env_dim("SENDAI_PTY_ROWS", 24)

    pid, master = pty.fork()
    if pid == 0:
        # Child: the slave pty is now our controlling terminal (pty.fork dup'd it
        # onto fd 0/1/2). Size it before exec so tmux starts at the device's
        # dimensions, then replace ourselves with the requested command.
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError as exc:
            sys.stderr.write(f"pty.py: TIOCSWINSZ failed: {exc}\n")
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:
            sys.stderr.write(f"pty.py: exec {argv[0]} failed: {exc}\n")
            os._exit(127)
        return 0  # unreachable

    # Parent: relay stdin -> master and master -> stdout until the master EOFs
    # (tmux client exited) or our stdin closes.
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    os.set_blocking(master, False)
    os.set_blocking(stdin_fd, False)

    stdin_open = True
    while True:
        watch = [master]
        if stdin_open:
            watch.append(stdin_fd)
        try:
            readable, _, _ = select.select(watch, [], [])
        except (InterruptedError, OSError):
            continue

        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break  # tmux exited
            _write_all(stdout_fd, data)

        if stdin_open and stdin_fd in readable:
            try:
                data = os.read(stdin_fd, 65536)
            except OSError:
                data = b""
            if not data:
                stdin_open = False  # host closed our stdin; keep draining master
            else:
                _write_all(master, data)

    try:
        _, status = os.waitpid(pid, 0)
    except OSError:
        status = 0
    return os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0


def _write_all(fd: int, data: bytes) -> None:
    while data:
        try:
            n = os.write(fd, data)
        except BlockingIOError:
            select.select([], [fd], [])
            continue
        except OSError:
            return
        data = data[n:]


if __name__ == "__main__":
    sys.exit(main())
