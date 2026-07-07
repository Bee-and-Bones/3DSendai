// U6 (plan-005) end-to-end: herdr panes bridged through the REAL encrypted
// server to a secure device. Proves the herdr path (board, control-channel
// repaint, keystroke, agent-status alert) rides the XChaCha20-Poly1305
// transport with NO cleartext — mirroring e2e-tmux.test.ts.
//
// Hermetic: a fake herdr daemon (fixture-shaped socket responses) and a fake
// control-channel child; the server, crypto, and framing are all real.

import { afterAll, beforeAll, expect, test } from "bun:test";
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
  type TerminalDataPayload,
} from "@agentbus/protocol";
import { createHost } from "../src/app.ts";
import { HerdrBridge, type HerdrChild, type HerdrRunner } from "../src/herdr/bridge.ts";
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

  // The queued resync opened the focused pane's control channel; its first
  // (full) frame is the repaint and streams down as encrypted TERMINAL_DATA.
  await dev.waitFor(() => children.length > 0);
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
