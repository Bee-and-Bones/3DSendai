// U31 live TmuxRunner: the Bun.spawn side of the bridge seam. Kept out of
// bridge.ts so the bridge stays hermetically testable (bridge takes an injected
// TmuxRunner). This is the only file that touches a real tmux/pty.
//
// The control-mode child is `python3 <pty.py> tmux [-L <sock>] -CC attach
// [-t <session>]` because `tmux -CC` requires a controlling pty (S3/KTD1); the
// Python helper allocates it and relays the master fd over ordinary pipes.
// Enumeration and capture-pane are plain `tmux ... -F` calls (no pty needed).

import { fileURLToPath } from "node:url";
import type { ControlChild, TmuxRunner } from "./bridge.ts";

// Named tmux-pty.py (not pty.py) so python's sys.path[0] insert doesn't shadow
// the stdlib `pty` module the helper imports.
const PTY_HELPER = fileURLToPath(new URL("./tmux-pty.py", import.meta.url));

export interface TmuxRunnerOptions {
  /** tmux socket name (`-L`); omit for the default socket. */
  socket?: string;
  /** Attach target session name (`-t`); omit to attach the whole server. */
  session?: string;
  /** python3 binary (default "python3"). */
  python?: string;
  /** tmux binary (default "tmux"). */
  tmux?: string;
}

export function createTmuxRunner(opts: TmuxRunnerOptions = {}): TmuxRunner {
  const python = opts.python ?? "python3";
  const tmux = opts.tmux ?? "tmux";
  const base = opts.socket ? [tmux, "-L", opts.socket] : [tmux];

  function tmuxSync(args: string[]): string {
    const proc = Bun.spawnSync([...base, ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      const err = new TextDecoder().decode(proc.stderr).trim();
      throw new Error(err || `tmux ${args[0]} exited ${proc.exitCode}`);
    }
    return new TextDecoder().decode(proc.stdout);
  }

  return {
    listSessions(): string[] {
      const out = tmuxSync(["list-sessions", "-F", "#{session_name}:#{session_id}"]);
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    },

    capturePane(target: string): string {
      return tmuxSync(["capture-pane", "-t", target, "-e", "-p"]);
    },

    spawnControl(): ControlChild {
      const attach = ["-CC", "attach", ...(opts.session ? ["-t", opts.session] : [])];
      const child = Bun.spawn([python, PTY_HELPER, ...base, ...attach], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });

      let onData: ((bytes: Uint8Array) => void) | undefined;
      let onExit: (() => void) | undefined;

      void (async () => {
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) onData?.(value);
          }
        } finally {
          reader.releaseLock();
        }
      })();

      void child.exited.then(() => onExit?.());

      return {
        onData(listener) {
          onData = listener;
        },
        onExit(listener) {
          onExit = listener;
        },
        write(line: string) {
          const w = (child.stdin as { write(chunk: Uint8Array): void }).write;
          w.call(child.stdin, new TextEncoder().encode(line + "\n"));
        },
        kill() {
          child.kill();
        },
      };
    },
  };
}
