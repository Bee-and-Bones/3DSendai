// U2 (plan-004) control-mode winsize integration: a REAL tmux server, attached
// through the real pty helper (tmux-pty.py), must render at the device's width
// so a long line wraps exactly once — at 50 cols, not tmux's 80-col default.
// This is the R1 acceptance check the hermetic bridge tests can't cover.
//
// Skipped when tmux/python3 are missing (CI without tmux). Uses a private -L
// socket + -f /dev/null so the user's tmux server and config are untouched.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { MSG } from "@agentbus/protocol";
import { TmuxBridge } from "../src/tmux/bridge.ts";
import { createTmuxRunner } from "../src/tmux/runner.ts";

const hasTmux = Bun.which("tmux") !== null && Bun.which("python3") !== null;
const SOCK = `3dsendai-kat-${process.pid}`;

function tmux(...args: string[]): string {
  const proc = Bun.spawnSync(["tmux", "-L", SOCK, "-f", "/dev/null", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr));
  return new TextDecoder().decode(proc.stdout);
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout waiting for tmux state");
    await Bun.sleep(50);
  }
}

let bridge: TmuxBridge | undefined;

beforeAll(() => {
  if (!hasTmux) return;
  // A detached session running a bare shell; no client yet, so tmux uses its
  // 80x24 default until our control client attaches.
  tmux("new-session", "-d", "-s", "kat", "-x", "80", "-y", "24", "sh");
});

afterAll(() => {
  bridge?.stop();
  if (hasTmux) {
    try {
      tmux("kill-server");
    } catch {
      // already gone
    }
  }
});

test.skipIf(!hasTmux)(
  "pty at 50 cols: a 60-char line wraps exactly once (R1)",
  async () => {
    const runner = createTmuxRunner({ socket: SOCK, session: "kat" });
    bridge = new TmuxBridge({ runner, sink: () => {} });
    bridge.start();

    // The control client attaches through tmux-pty.py (pty sized 50x24, which
    // tmux 3.7 control clients ignore) and the bridge's spawn-time
    // `refresh-client -C 50x24` bootstrap sizes the client; window-size
    // defaults to "latest", so the session shrinks to 50 cols.
    await until(() => {
      try {
        return tmux("display-message", "-p", "-t", "kat", "#{window_width}").trim() === "50";
      } catch {
        return false;
      }
    });

    // Print a 60-char marker line; at 50 cols it must wrap exactly once. Built
    // via printf so the typed command line itself contains no W-run (the echoed
    // command would otherwise wrap too and pollute the assertion).
    tmux("send-keys", "-t", "kat", `printf 'W%.0s' $(seq 60); echo`, "Enter");
    await until(() => tmux("capture-pane", "-t", "kat", "-p").includes("W".repeat(10)));
    const lines = tmux("capture-pane", "-t", "kat", "-p").split("\n");
    const wrapped = lines.filter((l) => /^W+$/.test(l.trim()) && l.trim().length > 0);
    expect(wrapped.length).toBe(2); // 50 + 10 — wrapped once, at device width
    expect(wrapped[0]!.trim().length).toBe(50);
    expect(wrapped[1]!.trim().length).toBe(10);

    // A CLIENT_SIZE routed through the bridge re-sizes the live client.
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 40, rows: 20 });
    await until(
      () => tmux("display-message", "-p", "-t", "kat", "#{window_width}").trim() === "40",
    );
  },
  15_000,
);
