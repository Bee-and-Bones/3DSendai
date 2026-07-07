// U4 (plan-005) live HerdrRunner: the Bun side of the herdr seam. Kept out of
// bridge.ts so the bridge stays hermetically testable (bridge takes an
// injected HerdrRunner). This is the only file that touches a real herdr.
//
// The control channel is `herdr [--session <name>] terminal session control
// <pane> --takeover --cols C --rows R` over plain pipes — NDJSON both ways,
// no PTY needed (U1). --takeover so a device reconnect replaces the stale
// channel a dead host left behind.

import { homedir } from "node:os";
import { join } from "node:path";
import { herdrDialer } from "./socket.ts";
import type { HerdrChild, HerdrRunner } from "./bridge.ts";

export interface HerdrRunnerOptions {
  /** Named herdr session; omit for the default session. */
  session?: string;
  /** Explicit api socket path; overrides the session-derived default. */
  socket?: string;
  /** herdr binary (default "herdr"). */
  herdr?: string;
}

/**
 * herdr's own socket layout: the default session lives at
 * ~/.config/herdr/herdr.sock, a named session at
 * ~/.config/herdr/sessions/<name>/herdr.sock. Explicit path wins.
 */
export function resolveHerdrSocket(opts: HerdrRunnerOptions, home: string = homedir()): string {
  if (opts.socket) return opts.socket;
  if (opts.session) return join(home, ".config", "herdr", "sessions", opts.session, "herdr.sock");
  return join(home, ".config", "herdr", "herdr.sock");
}

export function createHerdrRunner(opts: HerdrRunnerOptions = {}): HerdrRunner {
  const herdr = opts.herdr ?? "herdr";
  const base = opts.session ? [herdr, "--session", opts.session] : [herdr];

  return {
    dial: herdrDialer(resolveHerdrSocket(opts)),

    spawnControl(paneId: string, cols: number, rows: number): HerdrChild {
      const child = Bun.spawn(
        [...base, "terminal", "session", "control", paneId, "--takeover", "--cols", String(cols), "--rows", String(rows)],
        { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
      );

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
          (child.stdin as { flush?(): void }).flush?.();
        },
        kill() {
          child.kill();
        },
      };
    },
  };
}
