// U38 end-to-end: a tmux session, bridged through the REAL encrypted server to a
// secure device. Proves the terminal path (SESSION_STATE, TERMINAL_DATA,
// KEYSTROKE) rides the XChaCha20-Poly1305 transport with NO cleartext (AE4) —
// terminal bytes and keystrokes are as protected as any other AgentBus frame.
//
// Hermetic: a fake TmuxRunner injects the control-mode stream (no live tmux); the
// server, crypto, and framing are all real.

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
  type TerminalDataPayload,
} from "@agentbus/protocol";
import { createHost } from "../src/app.ts";
import { TmuxBridge, type ControlChild, type TmuxRunner } from "../src/tmux/bridge.ts";

const PSK = fromHex("11".repeat(32));

// --- fake tmux (control-mode child driven by hand) ---
class FakeChild implements ControlChild {
  data: ((b: Uint8Array) => void) | undefined;
  exit: (() => void) | undefined;
  writes: string[] = [];
  onData(l: (b: Uint8Array) => void) { this.data = l; }
  onExit(l: () => void) { this.exit = l; }
  write(line: string) { this.writes.push(line); }
  kill() {}
  feed(text: string) { this.data?.(new TextEncoder().encode(text)); }
}
function fakeRunner(child: FakeChild): TmuxRunner {
  return {
    listSessions: () => ["work:$0"],
    capturePane: () => "$ ",
    spawnControl: () => child,
  };
}

// --- a minimal secure device that records every raw wire byte (for AE4) ---
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
  async waitFor(pred: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise<void>((r) => this.waiters.push(r));
      if (!pred()) await Bun.sleep(5);
    }
  }
}

let child: FakeChild;
let host: Awaited<ReturnType<typeof createHost>>;

beforeAll(async () => {
  await cryptoReady();
  child = new FakeChild();
  const bridge = new TmuxBridge({ runner: fakeRunner(child) });
  host = await createHost({ host: "127.0.0.1", port: 0, token: "t", psk: PSK }, { bridge });
});
afterAll(() => host.stop());

test("encrypted terminal loop: attach, session, stream, keystroke — no cleartext (AE4)", async () => {
  const dev = await SecureDevice.connect(host.port);
  await dev.waitFor(() => dev.epoch !== null);
  dev.send(MSG.ATTACH, 0, { token: "t" });
  await dev.waitFor(() => dev.of(MSG.HELLO).length > 0);

  // The bridge enumerated the tmux session on attach.
  await dev.waitFor(() => dev.of(MSG.SESSION_STATE).length > 0);
  const sid = (dev.of(MSG.SESSION_STATE)[0]!.payload as { sessionId: number }).sessionId;

  // Pane output streams down as encrypted TERMINAL_DATA. Wait for the MARKER
  // frame itself, not just the first TERMINAL_DATA — the KTD3 resync screen
  // ("$ ") arrives first and used to satisfy the wait before the marker landed.
  const MARKER = "E2E_MARKER_9f3a";
  child.feed(`%output %0 ${MARKER}\r\n`);
  const decodedAll = () =>
    new TextDecoder().decode(
      fromHex(dev.of(MSG.TERMINAL_DATA).map((f) => (f.payload as TerminalDataPayload).hex).join("")),
    );
  await dev.waitFor(() => decodedAll().includes(MARKER));
  expect(decodedAll()).toContain(MARKER);

  // A device keystroke becomes a tmux send-keys for that pane.
  dev.send(MSG.KEYSTROKE, sid, { sessionId: sid, hex: toHex(new TextEncoder().encode("ls\r")) });
  await Bun.sleep(50);
  expect(child.writes.some((w) => w.startsWith("send-keys") && w.includes("6c 73 0d"))).toBe(true);

  // AE4: reassemble every byte that crossed the wire; assert no cleartext.
  const all = [...dev.rawIn, ...dev.rawOut];
  const total = all.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of all) { merged.set(c, off); off += c.length; }
  const wireText = new TextDecoder("latin1").decode(merged);
  for (const secret of [MARKER, "send-keys", "sessionId", '"hex"', "6c730d", "work"]) {
    expect(wireText.includes(secret)).toBe(false);
  }
  expect(total).toBeGreaterThan(80);
  dev.socket.end();
});
