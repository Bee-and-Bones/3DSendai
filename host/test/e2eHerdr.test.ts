// U6 (plan-005) end-to-end: herdr panes bridged through the REAL encrypted
// server to a secure device. Proves the herdr path (board, control-channel
// repaint, keystroke, agent-status alert) rides the XChaCha20-Poly1305
// transport with NO cleartext — mirroring e2eTmux.test.ts.
//
// Hermetic: a fake herdr daemon (fixture-shaped socket responses) and a fake
// control-channel child; the server, crypto, and framing are all real.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Socket } from "bun";
import {
  cryptoReady,
  sealRecord,
  openRecord,
  SecureRecordDecoder,
  lengthPrefix,
  encodeFrame,
  FrameDecoder,
  fromHex,
  toHex,
  MSG,
  EPOCH_BYTES,
  DIR_UP,
  DIR_DOWN,
  type Frame,
  type AlertSignalPayload,
  type SessionListPayload,
  type SessionSummary,
  type TerminalDataPayload,
} from "@agentbus/protocol";
import { createHost } from "../src/app.ts";
import {
  HerdrBridge,
  type HerdrChild,
  type HerdrRunner,
  type MakeRunner,
} from "../src/herdr/bridge.ts";
import type { HerdrConn, HerdrDial } from "../src/herdr/socket.ts";

const PSK = fromHex("22".repeat(32));

// --- fake herdr: api socket + control channel ---------------------------------

class FakeChild implements HerdrChild {
  data: ((b: Uint8Array) => void) | undefined;
  exitL: (() => void) | undefined;
  writes: string[] = [];
  constructor(readonly paneId: string) {}
  onData(l: (b: Uint8Array) => void) { this.data = l; }
  onExit(l: () => void) { this.exitL = l; }
  write(line: string) { this.writes.push(line); }
  kill() {}
  frame(text: string) {
    const rec = { type: "terminal.frame", seq: 1, full: true, width: 50, height: 24, encoding: "base64", bytes: Buffer.from(text).toString("base64") };
    this.data?.(new TextEncoder().encode(JSON.stringify(rec) + "\n"));
  }
}

const children: FakeChild[] = [];
let pushEvent: ((event: string, data: Record<string, unknown>) => void) | undefined;

function fakeRunner(): HerdrRunner {
  const dial: HerdrDial = async () => {
    let dataL: ((b: Uint8Array) => void) | undefined;
    let closeL: (() => void) | undefined;
    const conn: HerdrConn = {
      write(line: string) {
        const msg = JSON.parse(line) as { id: string; method: string };
        const reply = (obj: unknown) => dataL?.(new TextEncoder().encode(JSON.stringify(obj) + "\n"));
        if (msg.method === "ping") {
          reply({ id: msg.id, result: { type: "pong", version: "0.7.2", protocol: 16 } });
          closeL?.();
        } else if (msg.method === "session.snapshot") {
          reply({
            id: msg.id,
            result: {
              type: "session_snapshot",
              snapshot: {
                version: "0.7.2",
                protocol: 16,
                focused_pane_id: "w1:p1",
                workspaces: [{ workspace_id: "w1", label: "work" }],
                tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "dev" }],
                panes: [{ pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "unknown", agent: "claude", title: null }],
              },
            },
          });
          closeL?.();
        } else if (msg.method === "events.subscribe") {
          reply({ id: msg.id, result: { type: "subscription_started" } });
          pushEvent = (event, data) => dataL?.(new TextEncoder().encode(JSON.stringify({ data, event }) + "\n"));
        }
      },
      onData(l) { dataL = l; },
      onClose(l) { closeL = l; },
      end() {},
    };
    return conn;
  };
  return {
    dial,
    spawnControl(paneId) {
      const child = new FakeChild(paneId);
      children.push(child);
      return child;
    },
  };
}

// --- a minimal secure device that records every raw wire byte -----------------

class SecureDevice {
  socket!: Socket;
  epoch: bigint | null = null;
  private sendSeq = 0n;
  private recvSeq = 0n;
  private buf = new Uint8Array(0);
  private readonly recDec = new SecureRecordDecoder();
  private readonly frameDec = new FrameDecoder();
  readonly frames: Frame[] = [];
  readonly rawIn: Uint8Array[] = [];
  readonly rawOut: Uint8Array[] = [];
  private waiters: Array<() => void> = [];

  static async connect(port: number): Promise<SecureDevice> {
    const d = new SecureDevice();
    d.socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data: (_s, b) => d.onData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) },
    });
    return d;
  }
  private onData(chunk: Uint8Array) {
    this.rawIn.push(chunk.slice());
    const j = new Uint8Array(this.buf.length + chunk.length);
    j.set(this.buf); j.set(chunk, this.buf.length);
    this.buf = j;
    if (this.epoch === null) {
      if (this.buf.length < EPOCH_BYTES) return;
      this.epoch = new DataView(this.buf.buffer).getBigUint64(0, false);
      this.buf = this.buf.subarray(EPOCH_BYTES);
    }
    for (const rec of this.recDec.push(this.buf)) {
      const plain = openRecord(PSK, DIR_DOWN, this.epoch, this.recvSeq, rec);
      this.recvSeq += 1n;
      if (plain) for (const f of this.frameDec.push(plain)) this.frames.push(f);
    }
    this.buf = new Uint8Array(0);
    this.waiters.splice(0).forEach((w) => w());
  }
  send(type: number, sid: number, payload: unknown) {
    if (this.epoch === null) throw new Error("no epoch");
    const wire = lengthPrefix(sealRecord(PSK, DIR_UP, this.epoch, this.sendSeq, encodeFrame(type, sid, payload)));
    this.sendSeq += 1n;
    this.rawOut.push(wire.slice());
    this.socket.write(wire);
  }
  of(type: number) { return this.frames.filter((f) => f.type === type); }
  async waitFor(pred: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise<void>((r) => this.waiters.push(r));
      if (!pred()) await Bun.sleep(5);
    }
  }
}

let host: Awaited<ReturnType<typeof createHost>>;

beforeAll(async () => {
  await cryptoReady();
  const bridge = new HerdrBridge({ runner: fakeRunner(), log: () => {} });
  host = await createHost({ host: "127.0.0.1", port: 0, token: "t", psk: PSK }, { bridge });
});
afterAll(() => host.stop());

test("encrypted herdr loop: attach, board, repaint, keystroke, alert — no cleartext", async () => {
  const dev = await SecureDevice.connect(host.port);
  await dev.waitFor(() => dev.epoch !== null);
  dev.send(MSG.ATTACH, 0, { token: "t" });
  await dev.waitFor(() => dev.of(MSG.HELLO).length > 0);

  // Board arrives once the async herdr bootstrap resolves: per-pane
  // SESSION_STATE then the SESSION_LIST boundary, label carrying tab/agent.
  await dev.waitFor(() => dev.of(MSG.SESSION_LIST).length > 0);
  const state = dev.of(MSG.SESSION_STATE)[0]!.payload as { sessionId: number; agent: string };
  expect(state.agent).toBe("herdr:dev/claude [claude]");
  const sid = state.sessionId;

  // Channels are lazy (U4): attaching only paints the board — no control
  // channel opens until the device focuses a row. Focus the pane; its freshly
  // spawned channel's first (full) frame is the repaint, streaming down as
  // encrypted TERMINAL_DATA.
  dev.send(MSG.FOCUS_SESSION, sid, { sessionId: sid });
  // Poll: opening a channel emits no downstream frame, so waitFor (which only
  // wakes on inbound data) can't observe it — mirror the keystroke poll below.
  for (const end = Date.now() + 3000; children.length === 0; ) {
    if (Date.now() > end) throw new Error("timeout waiting for control channel");
    await Bun.sleep(10);
  }
  const child = children.at(-1)!;
  expect(child.paneId).toBe("w1:p1");
  const MARKER = "HERDR_E2E_7c2f";
  child.frame(`\x1b[2J\x1b[H${MARKER}`);
  const decodedAll = () =>
    new TextDecoder().decode(
      fromHex(dev.of(MSG.TERMINAL_DATA).map((f) => (f.payload as TerminalDataPayload).hex).join("")),
    );
  await dev.waitFor(() => decodedAll().includes(MARKER));

  // A device keystroke lands in the fake pane as one base64 terminal.input.
  // (Poll: keystrokes produce no downstream frame, so waitFor can't wake.)
  dev.send(MSG.KEYSTROKE, sid, { sessionId: sid, hex: toHex(new TextEncoder().encode("ls\r")) });
  for (const end = Date.now() + 2000; child.writes.length === 0; ) {
    if (Date.now() > end) throw new Error("timeout waiting for keystroke to land");
    await Bun.sleep(10);
  }
  const input = JSON.parse(child.writes[0]!) as { type: string; bytes: string };
  expect(input.type).toBe("terminal.input");
  expect(Buffer.from(input.bytes, "base64").toString()).toBe("ls\r");

  // A blocked agent-status push becomes an attention ALERT_SIGNAL.
  pushEvent!("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" });
  await dev.waitFor(() => dev.of(MSG.ALERT_SIGNAL).length > 0);
  expect((dev.of(MSG.ALERT_SIGNAL)[0]!.payload as AlertSignalPayload).class).toBe("attention");

  // Reassemble every byte that crossed the wire; assert no cleartext.
  const all = [...dev.rawIn, ...dev.rawOut];
  const total = all.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of all) { merged.set(c, off); off += c.length; }
  const wireText = new TextDecoder("latin1").decode(merged);
  for (const secret of [MARKER, "terminal.input", "herdr:dev", "attention", "blocked", '"hex"', "6c730d"]) {
    expect(wireText.includes(secret)).toBe(false);
  }
  expect(total).toBeGreaterThan(80);
  dev.socket.end();
});

// --- U9: multi-session board, cursor-targeted approvals, isolation ------------
//
// These cases run the U4 multi-session bridge (makeRunner + discover seams) under
// the SAME real sealed server + hand-built SecureDevice as above. Two fake herdr
// daemons flatten into one encrypted board; a MACRO_INTENT approve drives the
// fresh-snapshot -> pane.send_keys path into the RIGHT daemon; a dropped daemon
// isolates to its own rows. The fake daemon mirrors host/test/herdrBridge.test.ts
// conventions (answer-first-then-close request conns; one long-lived subscribe
// conn per session; requests recorded for assertion).

interface E2EPane {
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  title?: string | null;
  agent?: string | null;
  display_agent?: string | null;
  agent_status?: string;
  focused?: boolean;
}

interface DaemonState {
  panes: Array<Record<string, unknown> & { pane_id: string; focused: boolean; agent_status: string }>;
  requests: Array<{ id: string; method: string; params?: Record<string, unknown> }>;
  subConns: DaemonConn[];
  children: FakeChild[];
  wsLabels: Record<string, string>;
}

/** One request/subscribe connection to a fake daemon (herdr's NDJSON idiom). */
class DaemonConn implements HerdrConn {
  private dataL: ((b: Uint8Array) => void) | undefined;
  private closeL: (() => void) | undefined;
  ended = false;
  constructor(readonly state: DaemonState) {}
  write(line: string) {
    const msg = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
    this.state.requests.push(msg);
    const reply = (obj: unknown) => this.feed(JSON.stringify(obj) + "\n");
    switch (msg.method) {
      case "ping":
        reply({ id: msg.id, result: { type: "pong", version: "0.7.3", protocol: 16 } });
        this.close();
        return;
      case "session.snapshot":
        reply({
          id: msg.id,
          result: {
            type: "session_snapshot",
            snapshot: {
              version: "0.7.3",
              protocol: 16,
              focused_pane_id: this.state.panes.find((p) => p.focused)?.pane_id,
              workspaces: Object.entries(this.state.wsLabels).map(([workspace_id, label]) => ({
                workspace_id,
                label,
              })),
              tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
              panes: this.state.panes,
            },
          },
        });
        this.close();
        return;
      case "events.subscribe":
        this.state.subConns.push(this);
        reply({ id: msg.id, result: { type: "subscription_started" } });
        return;
      case "pane.send_keys":
        reply({ id: msg.id, result: { type: "ok" } });
        this.close();
        return;
      default:
        reply({ id: msg.id, error: { code: "invalid_request", message: `unknown method ${msg.method}` } });
        this.close();
    }
  }
  onData(l: (b: Uint8Array) => void) { this.dataL = l; }
  onClose(l: () => void) { this.closeL = l; }
  end() { this.ended = true; }
  feed(text: string) { this.dataL?.(new TextEncoder().encode(text)); }
  close() { this.closeL?.(); }
}

function makeDaemon(initialPanes: E2EPane[], wsLabels: Record<string, string> = { w1: "work" }) {
  const state: DaemonState = {
    panes: initialPanes.map((p) => ({
      pane_id: p.pane_id,
      terminal_id: `term_${p.pane_id}`,
      workspace_id: p.workspace_id ?? "w1",
      tab_id: p.tab_id ?? "w1:t1",
      focused: p.focused ?? false,
      agent_status: p.agent_status ?? "unknown",
      agent: p.agent ?? null,
      display_agent: p.display_agent ?? null,
      title: p.title ?? null,
    })),
    requests: [],
    subConns: [],
    children: [],
    wsLabels,
  };
  const dial: HerdrDial = async () => new DaemonConn(state);
  const runner: HerdrRunner = {
    dial,
    spawnControl(paneId) {
      const child = new FakeChild(paneId);
      state.children.push(child);
      return child;
    },
  };
  const liveSub = () => [...state.subConns].reverse().find((c) => !c.ended);
  return {
    state,
    runner,
    push: (event: string, data: Record<string, unknown>) =>
      liveSub()?.feed(JSON.stringify({ data, event }) + "\n"),
    dropSubscription: () => liveSub()?.close(),
    count: (method: string) => state.requests.filter((r) => r.method === method).length,
  };
}

type FakeDaemon = ReturnType<typeof makeDaemon>;

/** Build a multi-session bridge harness with captured (never auto-firing) timers. */
function buildMulti(config: Record<string, E2EPane[]>) {
  const daemons: Record<string, FakeDaemon> = {};
  for (const [name, panes] of Object.entries(config)) daemons[name] = makeDaemon(panes);
  const targets = Object.keys(config)
    .sort()
    .map((name) => ({ session: name, socketPath: `/sock/${name}` }));
  const discover = async () => targets;
  const makeRunner: MakeRunner = (t) => daemons[t.session ?? ""]!.runner;
  const scheduled: Array<() => void> = [];
  const schedule = (fn: () => void) => {
    scheduled.push(fn);
    return fn;
  };
  const cancel = (h: unknown) => {
    const i = scheduled.indexOf(h as () => void);
    if (i >= 0) scheduled.splice(i, 1);
  };
  return { daemons, discover, makeRunner, schedule, cancel };
}

/** Stand up host+bridge+device, attach, and wait for the first board. */
async function attachMulti(config: Record<string, E2EPane[]>) {
  const m = buildMulti(config);
  const bridge = new HerdrBridge({
    makeRunner: m.makeRunner,
    discover: m.discover,
    schedule: m.schedule,
    cancel: m.cancel,
    refreshMs: 1000,
    log: () => {},
  });
  const host = await createHost({ host: "127.0.0.1", port: 0, token: "t", psk: PSK }, { bridge });
  const dev = await SecureDevice.connect(host.port);
  await dev.waitFor(() => dev.epoch !== null);
  dev.send(MSG.ATTACH, 0, { token: "t" });
  await dev.waitFor(() => dev.of(MSG.HELLO).length > 0);
  await dev.waitFor(() => dev.of(MSG.SESSION_LIST).length > 0);
  return { m, bridge, host, dev };
}

/** Poll a synchronous predicate (daemon-side state that never wakes waitFor). */
async function poll(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(5);
  }
}

const lastList = (dev: SecureDevice) =>
  dev.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
const states = (dev: SecureDevice) =>
  dev.of(MSG.SESSION_STATE).map((f) => f.payload as SessionSummary);
const alertsOf = (dev: SecureDevice, cls: string) =>
  dev.of(MSG.ALERT_SIGNAL).filter((f) => (f.payload as AlertSignalPayload).class === cls);

function mergedWire(dev: SecureDevice): { text: string; total: number } {
  const all = [...dev.rawIn, ...dev.rawOut];
  const total = all.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of all) {
    merged.set(c, off);
    off += c.length;
  }
  return { text: new TextDecoder("latin1").decode(merged), total };
}

describe("herdr e2e — multi-session board, approvals, isolation (U9)", () => {
  test("two daemons flatten into one encrypted board with session-prefixed labels and enriched fields", async () => {
    const { host, dev } = await attachMulti({
      alpha: [
        { pane_id: "w1:p1", agent: "claude", display_agent: "Claude", title: "alpha task", agent_status: "working", focused: true },
      ],
      beta: [
        { pane_id: "w1:p1", agent: "codex", display_agent: "Codex", title: "beta review", agent_status: "blocked", focused: true },
      ],
    });
    try {
      // The decrypted board carries BOTH daemons' single "w1:p1" pane, keyed to
      // distinct device ids and disambiguated by the session prefix.
      const list = lastList(dev);
      expect(list.sessions.length).toBe(2);
      expect(new Set(list.sessions.map((s) => s.sessionId)).size).toBe(2);
      expect(list.sessions.map((s) => s.agent).sort()).toEqual([
        "alpha/herdr:1/alpha task [claude]",
        "beta/herdr:1/beta review [codex]",
      ]);
      // Enriched fields ride the decrypted SESSION_STATE payloads (not prefixed).
      const byKind = new Map(states(dev).map((s) => [s.kind, s]));
      expect(byKind.get("claude")).toMatchObject({ agentName: "Claude", title: "alpha task", workspace: "work", status: "running_tool" });
      expect(byKind.get("codex")).toMatchObject({ agentName: "Codex", title: "beta review", workspace: "work", status: "blocked" });
    } finally {
      dev.socket.end();
      host.stop();
    }
  });

  test("MACRO_INTENT approve on a NON-focused blocked pane drives fresh-snapshot then one send_keys into the owning daemon", async () => {
    const { m, host, dev } = await attachMulti({
      alpha: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", focused: true }],
      beta: [{ pane_id: "w1:p1", agent: "codex", agent_status: "blocked", focused: true }],
    });
    try {
      const list = lastList(dev);
      const alpha = list.sessions.find((s) => s.agent.startsWith("alpha/"))!;
      const beta = list.sessions.find((s) => s.agent.startsWith("beta/"))!;
      // Terminal focus on alpha's (working) row — the approve must ignore it.
      dev.send(MSG.FOCUS_SESSION, alpha.sessionId, { sessionId: alpha.sessionId });
      await poll(() => m.daemons.alpha!.state.children.length === 1);
      const betaSnapsBefore = m.daemons.beta!.count("session.snapshot");
      // Approve targets beta via the frame-header session id (focus-independent).
      dev.send(MSG.MACRO_INTENT, beta.sessionId, { intent: "approve" });
      await poll(() => m.daemons.beta!.count("pane.send_keys") === 1);
      // A fresh snapshot preceded the single kind-mapped send_keys (codex -> y).
      expect(m.daemons.beta!.count("session.snapshot")).toBe(betaSnapsBefore + 1);
      const send = m.daemons.beta!.state.requests.find((r) => r.method === "pane.send_keys")!;
      expect(send.params).toEqual({ pane_id: "w1:p1", keys: ["y"] });
      // The focused daemon received no input at all.
      expect(m.daemons.alpha!.count("pane.send_keys")).toBe(0);
      await Bun.sleep(20);
      expect(dev.of(MSG.ERROR).length).toBe(0);
    } finally {
      dev.socket.end();
      host.stop();
    }
  });

  test("approve loses the not-blocked race: ERROR 'approval unavailable: not blocked' and zero send_keys", async () => {
    const { m, host, dev } = await attachMulti({
      solo: [{ pane_id: "w1:p1", agent: "codex", display_agent: "Codex", title: "t", agent_status: "blocked", focused: true }],
    });
    try {
      const row = lastList(dev).sessions[0]!;
      // The agent unblocks between the device tap and the bridge's fresh snapshot.
      m.daemons.solo!.state.panes[0]!.agent_status = "working";
      dev.send(MSG.MACRO_INTENT, row.sessionId, { intent: "approve" });
      await dev.waitFor(() => dev.of(MSG.ERROR).length > 0);
      expect((dev.of(MSG.ERROR).at(-1)!.payload as { message: string }).message).toBe(
        "approval unavailable: not blocked",
      );
      expect(m.daemons.solo!.count("pane.send_keys")).toBe(0);
    } finally {
      dev.socket.end();
      host.stop();
    }
  });

  test("a daemon dropping after attach ends only its own sessions; the other daemon stays live", async () => {
    const { m, host, dev } = await attachMulti({
      alpha: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", focused: true }],
      beta: [{ pane_id: "w1:p1", agent: "codex", agent_status: "idle", focused: true }],
    });
    try {
      const before = lastList(dev);
      const alphaId = before.sessions.find((s) => s.agent.startsWith("alpha/"))!.sessionId;
      const betaId = before.sessions.find((s) => s.agent.startsWith("beta/"))!.sessionId;
      m.daemons.alpha!.dropSubscription();
      // Exactly one session_ended, for alpha's device id.
      await dev.waitFor(() => alertsOf(dev, "session_ended").length > 0);
      const ended = alertsOf(dev, "session_ended");
      expect(ended.length).toBe(1);
      expect((ended[0]!.payload as AlertSignalPayload).sessionId).toBe(alphaId);
      // The rewritten board keeps beta and drops alpha; ERROR names alpha.
      await dev.waitFor(() => {
        const l = lastList(dev);
        return l.sessions.length === 1 && l.sessions[0]!.sessionId === betaId;
      });
      expect((dev.of(MSG.ERROR).at(-1)!.payload as { message: string }).message).toContain("(alpha)");
    } finally {
      dev.socket.end();
      host.stop();
    }
  });

  test("attach + resync with no focus opens zero control channels on any daemon", async () => {
    const { m, host, dev } = await attachMulti({
      alpha: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", focused: true }],
      beta: [{ pane_id: "w1:p1", agent: "codex", agent_status: "idle", focused: true }],
    });
    try {
      // createHost calls start()+resync() on attach; a bare board glance must NOT
      // --takeover any pane. Give resync a beat, then assert no channels spawned.
      await Bun.sleep(30);
      expect(m.daemons.alpha!.state.children.length).toBe(0);
      expect(m.daemons.beta!.state.children.length).toBe(0);
    } finally {
      dev.socket.end();
      host.stop();
    }
  });

  test("no cleartext on the raw wire for enriched payload bytes (title/agentName/kind)", async () => {
    const TITLE = "SECRET_TITLE_9f3a";
    const AGENTNAME = "AgentName_5b7e";
    const { host, dev } = await attachMulti({
      solo: [{ pane_id: "w1:p1", agent: "codex", display_agent: AGENTNAME, title: TITLE, agent_status: "blocked", focused: true }],
    });
    try {
      await dev.waitFor(() => states(dev).some((s) => s.title === TITLE));
      const { text, total } = mergedWire(dev);
      for (const secret of [TITLE, AGENTNAME, "codex", "herdr:1"]) {
        expect(text.includes(secret)).toBe(false);
      }
      expect(total).toBeGreaterThan(80);
    } finally {
      dev.socket.end();
      host.stop();
    }
  });

  test("back-compat: yesterday's parser (name -> agent, ignore unknown keys) renders the decorated label; no name key emitted", async () => {
    const { host, dev } = await attachMulti({
      solo: [{ pane_id: "w1:p1", agent: "claude", display_agent: "Claude", title: "build the thing", agent_status: "working", focused: true }],
    });
    try {
      await dev.waitFor(() => states(dev).length > 0);
      // Capture the enriched payload as the canonical JSON it crossed the wire as.
      const payload = states(dev).at(-1)!;
      const json = JSON.stringify(payload);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      // The pre-refactor client reads `name` preferentially, else `agent`.
      const label = ("name" in parsed ? parsed.name : parsed.agent) as string;
      expect("name" in parsed).toBe(false); // NO `name` key is ever emitted
      expect(json.includes('"name"')).toBe(false);
      expect(label).toBe("herdr:1/build the thing [claude]");
      // Unknown enriched keys are simply present-and-ignorable supersets.
      expect(parsed.kind).toBe("claude");
      expect(parsed.agentName).toBe("Claude");
    } finally {
      dev.socket.end();
      host.stop();
    }
  });

  test("reconnect resync re-delivers the enriched board and re-emits attention for a still-blocked pane (R11)", async () => {
    const { host, dev } = await attachMulti({
      solo: [{ pane_id: "w1:p1", agent: "codex", display_agent: "Codex", title: "t", agent_status: "blocked", focused: true }],
    });
    try {
      // The attach-time resync already re-derived attention for the blocked pane.
      await dev.waitFor(() => alertsOf(dev, "attention").length > 0);
      // Reconnect: a second secure device attaches to the same host (last sink wins).
      const dev2 = await SecureDevice.connect(host.port);
      await dev2.waitFor(() => dev2.epoch !== null);
      dev2.send(MSG.ATTACH, 0, { token: "t" });
      await dev2.waitFor(() => dev2.of(MSG.HELLO).length > 0);
      // Board re-delivered with the enriched fields intact...
      await dev2.waitFor(() => states(dev2).some((s) => s.kind === "codex"));
      const s = states(dev2).find((x) => x.kind === "codex")!;
      expect(s).toMatchObject({ agentName: "Codex", title: "t", status: "blocked" });
      // ...and the still-blocked pane's attention re-emitted (R11 continuity).
      await dev2.waitFor(() => alertsOf(dev2, "attention").length > 0);
      expect((alertsOf(dev2, "attention").at(-1)!.payload as AlertSignalPayload).sessionId).toBe(s.sessionId);
      dev2.socket.end();
    } finally {
      dev.socket.end();
      host.stop();
    }
  });
});
