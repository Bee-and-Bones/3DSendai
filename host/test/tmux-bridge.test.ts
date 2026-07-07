// U31/U32 TmuxBridge tests. Hermetic: a fake TmuxRunner injects a fake
// control-mode child stream and records tmux commands — no live tmux.

import { expect, test, describe } from "bun:test";
import {
  TmuxBridge,
  splitTerminalHex,
  clampSize,
  type ControlChild,
  type TmuxRunner,
} from "../src/tmux/bridge.ts";
import { MSG, fromHex, type AlertSignalPayload, type SessionListPayload, type TerminalDataPayload } from "@agentbus/protocol";

interface Emitted {
  type: number;
  sessionId: number;
  payload: unknown;
}

function collector() {
  const frames: Emitted[] = [];
  const sink = (type: number, sessionId: number, payload: unknown) => frames.push({ type, sessionId, payload });
  const of = (type: number) => frames.filter((f) => f.type === type);
  return { frames, sink, of };
}

// A fake control child the test drives by hand.
class FakeChild implements ControlChild {
  dataListener: ((b: Uint8Array) => void) | undefined;
  exitListener: (() => void) | undefined;
  writes: string[] = [];
  onData(l: (b: Uint8Array) => void) { this.dataListener = l; }
  onExit(l: () => void) { this.exitListener = l; }
  write(line: string) { this.writes.push(line); }
  kill() {}
  feed(text: string) { this.dataListener?.(new TextEncoder().encode(text)); }
  exit() { this.exitListener?.(); }
}

interface FakeRunner extends TmuxRunner {
  child: FakeChild;
  captures: string[];
}

function fakeRunner(sessions: string[], captureText = ""): FakeRunner {
  const child = new FakeChild();
  const captures: string[] = [];
  return {
    child,
    captures,
    listSessions: () => sessions,
    capturePane: (target: string) => { captures.push(target); return captureText; },
    spawnControl: () => child,
  };
}

function concatTerminalHex(frames: Emitted[], sessionId: number): string {
  return frames
    .filter((f) => f.type === MSG.TERMINAL_DATA && (f.payload as TerminalDataPayload).sessionId === sessionId)
    .map((f) => (f.payload as TerminalDataPayload).hex)
    .join("");
}

describe("splitTerminalHex", () => {
  test("keeps a small payload as one chunk", () => {
    expect(splitTerminalHex(1, "0a0b0c")).toEqual(["0a0b0c"]);
  });
  test(">16KB burst splits on even (byte-pair) boundaries", () => {
    const hex = "ab".repeat(40_000); // 40k bytes -> 80k hex chars, well over budget
    const parts = splitTerminalHex(1, hex);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length % 2).toBe(0);
    expect(parts.join("")).toBe(hex);
  });
});

describe("tmux bridge", () => {
  test("three sessions produce three SESSION_STATE frames + a SESSION_LIST (AE5)", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0", "web:$1", "worker:$2"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    const states = c.of(MSG.SESSION_STATE);
    expect(states.length).toBe(3);
    expect(states.map((s) => (s.payload as { agent: string }).agent).sort()).toEqual(["tmux:api", "tmux:web", "tmux:worker"]);
    const list = c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
    expect(list.sessions.length).toBe(3);
  });

  test("a pane write becomes TERMINAL_DATA whose decoded hex equals the bytes", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    // "hi\r\n" with an ESC sequence, octal-escaped by tmux.
    runner.child.feed("%output %0 h\\033[1mi\r\n");
    const hex = concatTerminalHex(c.frames, 1);
    expect(new TextDecoder().decode(fromHex(hex))).toBe("h\x1b[1mi");
  });

  test("a >16KB pane burst splits across multiple TERMINAL_DATA frames", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    const big = "x".repeat(20_000); // 20k printable bytes, no escapes
    runner.child.feed(`%output %0 ${big}\r\n`);
    expect(c.of(MSG.TERMINAL_DATA).length).toBeGreaterThan(1);
    expect(new TextDecoder().decode(fromHex(concatTerminalHex(c.frames, 1)))).toBe(big);
  });

  test("a KEYSTROKE frame results in a send-keys for the correct pane (AE6)", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    runner.child.feed("%output %0 ready\r\n"); // binds pane %0 to session 1
    bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: "0d" }); // Enter
    expect(runner.child.writes).toContain("send-keys -t %0 -H 0d");
  });

  test("resync sends the captured current screen (AE7)", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"], "SCREEN-CONTENTS");
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    bridge.resync(1);
    expect(runner.captures.length).toBe(1);
    const hex = concatTerminalHex(c.frames, 1);
    expect(new TextDecoder().decode(fromHex(hex))).toBe("SCREEN-CONTENTS");
  });

  test("attach failure (no sessions) yields a device ERROR frame, no hang", () => {
    const c = collector();
    const runner = fakeRunner([]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    const err = c.of(MSG.ERROR).at(0)!.payload as { message: string };
    expect(err.message).toContain("tmux attach failed");
    expect(c.of(MSG.SESSION_STATE).length).toBe(0);
  });

  test("attach failure (list-sessions throws) yields an ERROR, no throw", () => {
    const c = collector();
    const runner: TmuxRunner = {
      listSessions: () => { throw new Error("no server running on /tmp/tmux-x"); },
      capturePane: () => "",
      spawnControl: () => new FakeChild(),
    };
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    expect(() => bridge.start()).not.toThrow();
    expect((c.of(MSG.ERROR).at(0)!.payload as { message: string }).message).toContain("no server running");
  });

  // --- U32 alerts ---

  test("a foreground BEL in %output emits exactly one attention alert", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    runner.child.feed("%output %0 done\\007\r\n"); // BEL byte in the pane stream
    const alerts = c.of(MSG.ALERT_SIGNAL);
    expect(alerts.length).toBe(1);
    expect((alerts[0]!.payload as AlertSignalPayload).class).toBe("attention");
    expect((alerts[0]!.payload as AlertSignalPayload).sessionId).toBe(1);
  });

  test("%bell notification emits an attention alert", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    runner.child.feed("%bell @0\r\n");
    const alerts = c.of(MSG.ALERT_SIGNAL);
    expect(alerts.length).toBe(1);
    expect((alerts[0]!.payload as AlertSignalPayload).class).toBe("attention");
  });

  test("child exit / %exit emits session_ended per session", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0", "web:$1"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    runner.child.feed("%exit\r\n");
    const ended = c.of(MSG.ALERT_SIGNAL).filter((a) => (a.payload as AlertSignalPayload).class === "session_ended");
    expect(ended.length).toBe(2);
    // Idempotent: a subsequent child exit doesn't double-fire.
    runner.child.exit();
    expect(c.of(MSG.ALERT_SIGNAL).filter((a) => (a.payload as AlertSignalPayload).class === "session_ended").length).toBe(2);
  });

  test("routine output emits no alert", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    runner.child.feed("%output %0 hello world\r\n");
    expect(c.of(MSG.ALERT_SIGNAL).length).toBe(0);
  });

  // --- U2 (plan-004) client size ---

  test("CLIENT_SIZE {50,24} writes a refresh-client carrying 50x24", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 50, rows: 24 });
    expect(runner.child.writes).toContain("refresh-client -C 50x24");
  });

  test("new dims issue a new refresh-client; identical dims are a no-op", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 50, rows: 24 });
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 50, rows: 24 }); // repeat: no-op
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 80, rows: 30 });
    const refreshes = runner.child.writes.filter((w) => w.startsWith("refresh-client"));
    // First entry is the spawn-time bootstrap (control clients ignore the pty
    // winsize); the repeated {50,24} report emitted nothing.
    expect(refreshes).toEqual([
      "refresh-client -C 50x24", // bootstrap at spawn
      "refresh-client -C 50x24", // first CLIENT_SIZE report
      "refresh-client -C 80x30",
    ]);
  });

  test("zero/absurd dims are clamped to a sane floor before emission", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    const bridge = new TmuxBridge({ runner, sink: c.sink });
    bridge.start();
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 0, rows: 0 });
    expect(runner.child.writes).toContain("refresh-client -C 10x5");
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 100000, rows: -3 });
    expect(runner.child.writes).toContain("refresh-client -C 500x5");
  });

  test("clampSize floors, caps, and defaults non-finite dims", () => {
    expect(clampSize(50, 24)).toEqual({ cols: 50, rows: 24 });
    expect(clampSize(0, 0)).toEqual({ cols: 10, rows: 5 });
    expect(clampSize(100000, 100000)).toEqual({ cols: 500, rows: 500 });
    expect(clampSize(NaN, Infinity)).toEqual({ cols: 10, rows: 5 }); // non-finite -> floor
    expect(clampSize(50.9, 24.9)).toEqual({ cols: 50, rows: 24 });
  });

  test("idle-after-activity past the threshold emits exactly one likely_done", () => {
    const c = collector();
    const runner = fakeRunner(["api:$0"]);
    let now = 1000;
    const bridge = new TmuxBridge({ runner, sink: c.sink, idleThresholdMs: 5000, now: () => now });
    bridge.start();
    // Activity at t=1000.
    runner.child.feed("%output %0 working\r\n");
    expect(c.of(MSG.ALERT_SIGNAL).length).toBe(0);
    // Still within threshold: another chunk, no likely_done.
    now = 3000;
    runner.child.feed("%output %0 more\r\n");
    expect(c.of(MSG.ALERT_SIGNAL).filter((a) => (a.payload as AlertSignalPayload).class === "likely_done").length).toBe(0);
    // Past threshold with no new output: a tick (empty feed) triggers idle check.
    now = 9000;
    runner.child.feed(""); // ingest with no events -> checkIdle
    const likely = c.of(MSG.ALERT_SIGNAL).filter((a) => (a.payload as AlertSignalPayload).class === "likely_done");
    expect(likely.length).toBe(1);
    // Another tick does not re-fire.
    now = 20000;
    runner.child.feed("");
    expect(c.of(MSG.ALERT_SIGNAL).filter((a) => (a.payload as AlertSignalPayload).class === "likely_done").length).toBe(1);
  });
});
