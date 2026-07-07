// U4 (plan-005) HerdrBridge tests. Hermetic: a fake HerdrRunner provides a
// fake api-socket daemon (fixture-shaped responses) and fake control-channel
// children — no live herdr.
//
// Where the plan's scenario wording predates the U1 decision (pane.read
// repaints, send_input key names), the assertions here target the shipped
// control-channel design: the repaint is the first frame of a freshly spawned
// channel, and keystroke hex forwards verbatim as one base64 terminal.input.

import { expect, test, describe } from "bun:test";
import { HerdrBridge, sanitizeLabel, stripOsc, type HerdrChild, type HerdrRunner } from "../src/herdr/bridge.ts";
import { MSG, fromHex, toHex, type AlertSignalPayload, type SessionListPayload, type SessionSummary, type TerminalDataPayload } from "@agentbus/protocol";
import type { HerdrConn, HerdrDial } from "../src/herdr/socket.ts";

interface Emitted {
  type: number;
  sessionId: number;
  payload: unknown;
}

function collector() {
  const frames: Emitted[] = [];
  const sink = (type: number, sessionId: number, payload: unknown) => frames.push({ type, sessionId, payload });
  const of = (type: number) => frames.filter((f) => f.type === type);
  const alerts = (cls: string) => frames.filter((f) => f.type === MSG.ALERT_SIGNAL && (f.payload as AlertSignalPayload).class === cls);
  return { frames, sink, of, alerts };
}

// --- fake control-channel child -------------------------------------------------

class FakeChild implements HerdrChild {
  dataListener: ((b: Uint8Array) => void) | undefined;
  exitListener: (() => void) | undefined;
  writes: string[] = [];
  killed = false;
  constructor(readonly paneId: string, readonly cols: number, readonly rows: number) {}
  onData(l: (b: Uint8Array) => void) { this.dataListener = l; }
  onExit(l: () => void) { this.exitListener = l; }
  write(line: string) { this.writes.push(line); }
  kill() { this.killed = true; }
  /** Feed one NDJSON record as the herdr CLI would print it. */
  record(rec: unknown) { this.dataListener?.(new TextEncoder().encode(JSON.stringify(rec) + "\n")); }
  frame(bytes: string | Uint8Array, extra: Record<string, unknown> = {}) {
    const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    this.record({ type: "terminal.frame", seq: 1, full: true, width: this.cols, height: this.rows, encoding: "base64", bytes: Buffer.from(raw).toString("base64"), ...extra });
  }
}

// --- fake daemon + runner --------------------------------------------------------

interface FakePane {
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  title?: string | null;
  agent?: string | null;
  agent_status?: string;
  focused?: boolean;
}

function fakeHerdr(initialPanes: FakePane[], opts: { protocol?: number; failDial?: boolean } = {}) {
  const panes = initialPanes.map((p) => ({
    pane_id: p.pane_id,
    terminal_id: `term_${p.pane_id}`,
    workspace_id: p.workspace_id ?? "w1",
    tab_id: p.tab_id ?? "w1:t1",
    focused: p.focused ?? false,
    agent_status: p.agent_status ?? "unknown",
    agent: p.agent ?? null,
    title: p.title ?? null,
  }));
  const state = {
    panes,
    protocol: opts.protocol ?? 16,
    failDial: opts.failDial ?? false,
    children: [] as FakeChild[],
    subConns: [] as Array<{ conn: FakeConn; subs: Array<Record<string, unknown>> }>,
    requests: [] as Array<Record<string, unknown>>,
  };

  class FakeConn implements HerdrConn {
    dataListener: ((b: Uint8Array) => void) | undefined;
    closeListener: (() => void) | undefined;
    ended = false;
    write(line: string) {
      const msg = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
      state.requests.push(msg);
      const reply = (obj: unknown) => this.feed(JSON.stringify(obj) + "\n");
      switch (msg.method) {
        case "ping":
          reply({ id: msg.id, result: { type: "pong", version: "0.7.2", protocol: state.protocol } });
          this.close();
          return;
        case "session.snapshot":
          reply({
            id: msg.id,
            result: {
              type: "session_snapshot",
              snapshot: {
                version: "0.7.2",
                protocol: state.protocol,
                focused_pane_id: state.panes.find((p) => p.focused)?.pane_id,
                workspaces: [{ workspace_id: "w1", label: "work" }],
                tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
                panes: state.panes,
              },
            },
          });
          this.close();
          return;
        case "events.subscribe":
          state.subConns.push({ conn: this, subs: (msg.params?.subscriptions ?? []) as Array<Record<string, unknown>> });
          reply({ id: msg.id, result: { type: "subscription_started" } });
          return;
        default:
          reply({ id: msg.id, error: { code: "invalid_request", message: `unknown method ${msg.method}` } });
          this.close();
      }
    }
    onData(l: (b: Uint8Array) => void) { this.dataListener = l; }
    onClose(l: () => void) { this.closeListener = l; }
    end() { this.ended = true; }
    feed(text: string) { this.dataListener?.(new TextEncoder().encode(text)); }
    close() { this.closeListener?.(); }
  }

  const dial: HerdrDial = async () => {
    if (state.failDial) throw new Error("connect ENOENT herdr.sock");
    return new FakeConn();
  };

  const runner: HerdrRunner = {
    dial,
    spawnControl(paneId, cols, rows) {
      const child = new FakeChild(paneId, cols, rows);
      state.children.push(child);
      return child;
    },
  };

  /** Push an event to the newest live subscribe connection (as the daemon does). */
  function push(event: string, data: Record<string, unknown>) {
    const live = [...state.subConns].reverse().find((s) => !s.conn.ended);
    live?.conn.feed(JSON.stringify({ data, event }) + "\n");
  }
  /** Latest live subscription's requested types (for resubscribe assertions). */
  function currentSubs(): Array<Record<string, unknown>> {
    return [...state.subConns].reverse().find((s) => !s.conn.ended)?.subs ?? [];
  }
  function dropSubscription() {
    const live = [...state.subConns].reverse().find((s) => !s.conn.ended);
    live?.conn.close();
  }

  return { state, runner, push, currentSubs, dropSubscription };
}

type FakeConn = HerdrConn & { feed(text: string): void; close(): void; ended: boolean };

async function startedBridge(panes: FakePane[], opts: { size?: { cols: number; rows: number } } = {}) {
  const fake = fakeHerdr(panes);
  const c = collector();
  const bridge = new HerdrBridge({ runner: fake.runner, sink: c.sink, log: () => {} });
  bridge.start();
  await Bun.sleep(1);
  if (opts.size) bridge.route(MSG.CLIENT_SIZE, 0, opts.size);
  return { fake, c, bridge };
}

const lastChild = (fake: ReturnType<typeof fakeHerdr>) => fake.state.children.at(-1)!;

function terminalHex(frames: Emitted[], sessionId: number): string {
  return frames
    .filter((f) => f.type === MSG.TERMINAL_DATA && (f.payload as TerminalDataPayload).sessionId === sessionId)
    .map((f) => (f.payload as TerminalDataPayload).hex)
    .join("");
}

describe("helpers", () => {
  test("sanitizeLabel strips control/escape bytes and truncates", () => {
    // ESC/BEL/CR/LF stripped; printable remnants of an escape body survive as text.
    expect(sanitizeLabel("herdr:1/\x1b]0;evil\x07title\r\n")).toBe("herdr:1/]0;eviltitle");
    expect(sanitizeLabel("a".repeat(100)).length).toBe(40);
    expect(sanitizeLabel("plain")).toBe("plain");
  });

  test("stripOsc removes BEL- and ST-terminated OSC sequences, keeps the rest", () => {
    const input = new TextEncoder().encode("\x1b[?25l\x1b]8;;\x1b\\\x1b[2J\x1b[Hhi\x1b]0;title\x07!");
    const out = new TextDecoder().decode(stripOsc(input));
    expect(out).toBe("\x1b[?25l\x1b[2J\x1b[Hhi!");
  });
});

describe("herdr bridge", () => {
  test("enumeration emits SESSION_STATE per pane then SESSION_LIST, labels carrying tab/title", async () => {
    const { c } = await startedBridge([
      { pane_id: "w1:p1", title: "vim", focused: true },
      { pane_id: "w1:p2", agent: "claude", agent_status: "working" },
    ]);
    const states = c.of(MSG.SESSION_STATE);
    expect(states.length).toBe(2);
    const agents = states.map((s) => (s.payload as SessionSummary).agent).sort();
    expect(agents).toEqual(["herdr:1/claude [claude]", "herdr:1/vim"]);
    const list = c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
    expect(list.sessions.length).toBe(2);
    expect(list.sessions.find((s) => s.agent.includes("claude"))!.status).toBe("running_tool");
    // SESSION_STATE frames precede the SESSION_LIST boundary (per-object emission).
    const listIdx = c.frames.findIndex((f) => f.type === MSG.SESSION_LIST);
    expect(c.frames.slice(0, listIdx).filter((f) => f.type === MSG.SESSION_STATE).length).toBe(2);
  });

  test("zero panes is an empty board that gains a session on pane_created, not an error", async () => {
    const { fake, c } = await startedBridge([]);
    expect(c.of(MSG.ERROR).length).toBe(0);
    expect((c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload).sessions).toEqual([]);
    fake.push("pane_created", { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "unknown", agent: null, title: "sh" } });
    await Bun.sleep(1);
    const list = c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
    expect(list.sessions.length).toBe(1);
    expect(list.sessions[0]!.agent).toBe("herdr:1/sh");
  });

  test("start() opens no terminal channel until the device focuses or resyncs", async () => {
    const { fake } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    expect(fake.state.children.length).toBe(0);
  });

  test("resync opens the focused pane's channel; its first (full) frame is the repaint", async () => {
    const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.resync();
    const child = lastChild(fake);
    expect(child.paneId).toBe("w1:p1");
    child.frame("\x1b[2J\x1b[HSCREEN");
    expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 1)))).toBe("\x1b[2J\x1b[HSCREEN");
  });

  test("focus switch spawns the new pane's channel; late bytes on the old channel are dropped (R3)", async () => {
    const { fake, c, bridge } = await startedBridge([
      { pane_id: "w1:p1", focused: true },
      { pane_id: "w1:p2" },
    ]);
    bridge.resync();
    const oldChild = lastChild(fake);
    oldChild.frame("OLD-PANE-TAIL");
    bridge.route(MSG.FOCUS_SESSION, 0, { sessionId: 2 });
    const newChild = lastChild(fake);
    expect(oldChild.killed).toBe(true);
    expect(newChild.paneId).toBe("w1:p2");
    // Bytes arriving on the superseded channel after the switch: dropped.
    const before2 = terminalHex(c.frames, 2);
    const before1 = terminalHex(c.frames, 1);
    oldChild.record({ type: "terminal.frame", seq: 9, full: false, width: 50, height: 24, encoding: "base64", bytes: Buffer.from("SMEAR").toString("base64") });
    expect(terminalHex(c.frames, 2)).toBe(before2);
    expect(terminalHex(c.frames, 1)).toBe(before1);
    // The new channel's first frame paints session 2.
    newChild.frame("NEW-PANE-SCREEN");
    expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 2)))).toBe("NEW-PANE-SCREEN");
  });

  test("focus on an unknown session id is dropped without a spawn", async () => {
    const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.route(MSG.FOCUS_SESSION, 0, { sessionId: 99 });
    expect(fake.state.children.length).toBe(0);
  });

  test("keystroke hex for CR forwards as one base64 terminal.input on the focused channel", async () => {
    const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.resync();
    bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: "0d" });
    const child = lastChild(fake);
    expect(child.writes).toEqual([JSON.stringify({ type: "terminal.input", bytes: Buffer.from("\r").toString("base64"), encoding: "base64" })]);
  });

  test("mixed text+control payload (y + CR) and literal-with-newline keep byte order in one input", async () => {
    const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.resync();
    const child = lastChild(fake);
    bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: toHex(new TextEncoder().encode("y\r")) });
    bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: toHex(new TextEncoder().encode("echo a\nls")) });
    const decoded = child.writes.map((w) => Buffer.from((JSON.parse(w) as { bytes: string }).bytes, "base64").toString());
    expect(decoded).toEqual(["y\r", "echo a\nls"]);
  });

  test("keystrokes for stale/unknown/non-focused sessions and invalid hex are dropped", async () => {
    const { fake, bridge } = await startedBridge([
      { pane_id: "w1:p1", focused: true },
      { pane_id: "w1:p2" },
    ]);
    bridge.resync();
    const child = lastChild(fake);
    bridge.route(MSG.KEYSTROKE, 0, { sessionId: 99, hex: "0d" }); // unknown id
    bridge.route(MSG.KEYSTROKE, 0, { sessionId: 2, hex: "0d" }); // valid but not focused
    bridge.route(MSG.KEYSTROKE, 0, { sessionId: 1, hex: "zz" }); // invalid hex
    expect(child.writes).toEqual([]);
  });

  test("resync() called immediately after start() still repaints once the snapshot resolves", async () => {
    const fake = fakeHerdr([{ pane_id: "w1:p1", focused: true }]);
    const c = collector();
    const bridge = new HerdrBridge({ runner: fake.runner, sink: c.sink, log: () => {} });
    bridge.start();
    bridge.resync(); // pre-bootstrap: must queue, not vanish
    expect(fake.state.children.length).toBe(0);
    await Bun.sleep(1);
    expect(fake.state.children.length).toBe(1);
    expect(lastChild(fake).paneId).toBe("w1:p1");
  });

  test("CLIENT_SIZE clamps out-of-range values, dedupes, resizes live channel, sizes new channels", async () => {
    const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.resync();
    const child = lastChild(fake);
    expect([child.cols, child.rows]).toEqual([50, 24]); // default until a report arrives
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 0, rows: -3 });
    expect(child.writes).toContain(JSON.stringify({ type: "terminal.resize", cols: 10, rows: 5 }));
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 10, rows: 5 }); // duplicate after clamp: no-op
    expect(child.writes.filter((w) => w.includes("terminal.resize")).length).toBe(1);
    bridge.route(MSG.CLIENT_SIZE, 0, { cols: 40, rows: 20 });
    bridge.resync(); // respawn carries the current size
    expect([lastChild(fake).cols, lastChild(fake).rows]).toEqual([40, 20]);
  });

  test("blocked emits exactly one attention; working/unknown emit none; re-block re-alerts", async () => {
    const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" });
    expect(c.alerts("attention").length).toBe(1);
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" }); // duplicate state
    expect(c.alerts("attention").length).toBe(1);
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "working" });
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "unknown" });
    expect(c.alerts("attention").length).toBe(1);
    expect(c.alerts("likely_done").length).toBe(0);
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" });
    expect(c.alerts("attention").length).toBe(2); // once per transition
  });

  test("done emits likely_done once and updates the board status", async () => {
    const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "done" });
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "done" });
    expect(c.alerts("likely_done").length).toBe(1);
    const state = c.of(MSG.SESSION_STATE).at(-1)!.payload as SessionSummary;
    expect(state.status).toBe("done");
  });

  test("pane_exited emits session_ended once even if pane_closed follows", async () => {
    const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }, { pane_id: "w1:p2" }]);
    fake.push("pane_exited", { pane_id: "w1:p2", workspace_id: "w1" });
    fake.push("pane_closed", { pane_id: "w1:p2", workspace_id: "w1" });
    const ended = c.alerts("session_ended");
    expect(ended.length).toBe(1);
    expect((ended[0]!.payload as AlertSignalPayload).sessionId).toBe(2);
  });

  test("focused pane closing ends the stream and refreshes the board without auto-focusing", async () => {
    const { fake, c, bridge } = await startedBridge([
      { pane_id: "w1:p1", focused: true },
      { pane_id: "w1:p2" },
    ]);
    bridge.resync();
    const child = lastChild(fake);
    const childCount = fake.state.children.length;
    fake.push("pane_exited", { pane_id: "w1:p1", workspace_id: "w1" });
    expect(child.killed).toBe(true);
    expect(fake.state.children.length).toBe(childCount); // no auto-spawn on another pane
    const list = c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
    expect(list.sessions.map((s) => s.sessionId)).toEqual([2]);
    // Late keystrokes for the ended session are dropped.
    bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: "0d" });
    expect(child.writes).toEqual([]);
  });

  test("reconnect resync re-emits attention for a still-blocked pane but not one back to working (R11)", async () => {
    const { fake, c, bridge } = await startedBridge([
      { pane_id: "w1:p1", focused: true },
      { pane_id: "w1:p2" },
    ]);
    fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "a", agent_status: "blocked" });
    fake.push("pane.agent_status_changed", { pane_id: "w1:p2", agent: "b", agent_status: "blocked" });
    fake.push("pane.agent_status_changed", { pane_id: "w1:p2", agent: "b", agent_status: "working" });
    expect(c.alerts("attention").length).toBe(2);
    // Device reconnect: start() re-emits the board, resync() re-derives alerts.
    bridge.start();
    bridge.resync();
    const attention = c.alerts("attention");
    expect(attention.length).toBe(3);
    expect((attention.at(-1)!.payload as AlertSignalPayload).sessionId).toBe(1);
    // And a repaint channel was (re)opened for the focused pane.
    expect(lastChild(fake).paneId).toBe("w1:p1");
  });

  test("an oversized terminal frame splits into multiple TERMINAL_DATA under the cap", async () => {
    const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.resync();
    const big = "x".repeat(40_000);
    lastChild(fake).frame(big);
    expect(c.of(MSG.TERMINAL_DATA).length).toBeGreaterThan(1);
    expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 1)))).toBe(big);
  });

  test("frame bytes have OSC sequences stripped before hitting the device", async () => {
    const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.resync();
    lastChild(fake).frame("\x1b[?25l\x1b[?2026h\x1b]8;;\x1b\\\x1b[2J\x1b[Hhello");
    expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 1)))).toBe("\x1b[?25l\x1b[?2026h\x1b[2J\x1b[Hhello");
  });

  test("pane_created triggers a resubscribe that covers the new pane's agent status", async () => {
    const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    fake.push("pane_created", { pane: { pane_id: "w1:p9", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "unknown", agent: null, title: null } });
    await Bun.sleep(1);
    const subs = fake.currentSubs();
    expect(subs.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "w1:p9")).toBe(true);
    fake.push("pane.agent_status_changed", { pane_id: "w1:p9", agent: "codex", agent_status: "blocked" });
    expect(c.alerts("attention").length).toBe(1);
  });

  test("daemon connection loss ends all sessions with ERROR and a later start() succeeds", async () => {
    const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }, { pane_id: "w1:p2" }]);
    bridge.resync();
    fake.dropSubscription();
    expect(c.alerts("session_ended").length).toBe(2);
    expect(c.of(MSG.ERROR).length).toBe(1);
    expect((c.of(MSG.ERROR)[0]!.payload as { message: string }).message).toContain("connection lost");
    expect(lastChild(fake).killed).toBe(true);
    // Daemon restarts with a fresh pane set; a new device ATTACH retries cleanly.
    fake.state.panes.splice(0, fake.state.panes.length, {
      pane_id: "w1:p1", terminal_id: "term_w1:p1", workspace_id: "w1", tab_id: "w1:t1",
      focused: true, agent_status: "unknown", agent: null, title: null,
    });
    bridge.start();
    await Bun.sleep(1);
    const list = c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
    // Fresh id (3): device session ids are never reused within a host process.
    expect(list.sessions.map((s) => s.sessionId)).toEqual([3]);
  });

  test("bootstrap failure (daemon absent) emits ERROR, no hang, and a retry works", async () => {
    const fake = fakeHerdr([{ pane_id: "w1:p1", focused: true }]);
    fake.state.failDial = true;
    const c = collector();
    const bridge = new HerdrBridge({ runner: fake.runner, sink: c.sink, log: () => {} });
    bridge.start();
    await Bun.sleep(1);
    expect((c.of(MSG.ERROR)[0]!.payload as { message: string }).message).toContain("herdr attach failed");
    expect(c.of(MSG.SESSION_STATE).length).toBe(0);
    fake.state.failDial = false;
    bridge.start();
    await Bun.sleep(1);
    expect(c.of(MSG.SESSION_STATE).length).toBe(1);
  });

  test("takeover of the control channel surfaces as a device ERROR", async () => {
    const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
    bridge.resync();
    lastChild(fake).record({ type: "terminal.closed", reason: "terminal attach taken over" });
    expect((c.of(MSG.ERROR)[0]!.payload as { message: string }).message).toContain("taken over");
    // A clean self-release reason stays silent.
    lastChild(fake).record({ type: "terminal.closed", reason: "detached" });
    expect(c.of(MSG.ERROR).length).toBe(1);
  });
});
