// Host encrypted transport (U25): PSK config, epoch handshake, sealed frames
// both directions, and drop-on-anything-that-fails-to-decrypt. Mirrors the
// plaintext MockDevice in e2e.test.ts with a crypto-speaking variant.

import { expect, test, describe, beforeAll } from "bun:test";
import type { Socket } from "bun";
import {
  MSG,
  FrameDecoder,
  encodeFrame,
  cryptoReady,
  sealRecord,
  openRecord,
  lengthPrefix,
  SecureRecordDecoder,
  MAX_SECURE_RECORD,
  EPOCH_BYTES,
  DIR_DOWN,
  DIR_UP,
  type Frame,
} from "@agentbus/protocol";
import { createHost } from "../src/app.ts";
import { createServer } from "../src/server/index.ts";
import { assertBindAllowed } from "../src/server/auth.ts";
import { loadPsk, keyFromHex, keyToHex } from "../src/psk.ts";
import { FakeAdapter } from "./fakeAdapter.ts";

const PSK_HEX = "8f".repeat(16) + "1a".repeat(16);
const PSK: Uint8Array = keyFromHex(PSK_HEX);
const WRONG_PSK: Uint8Array = keyFromHex("42".repeat(32));

beforeAll(async () => {
  await cryptoReady();
});

/** MockDevice variant that speaks the sealed-record transport. */
class SecureMockDevice {
  private frameDec = new FrameDecoder();
  private recordDec = new SecureRecordDecoder();
  readonly frames: Frame[] = [];
  epoch: bigint | null = null;
  rawBytes = 0; // everything received off the wire, epoch included
  readonly rawInbound: Uint8Array[] = []; // raw wire chunks for AE4 inspection
  readonly rawOutbound: Uint8Array[] = [];
  closed = false;
  private buf: Uint8Array = new Uint8Array(0);
  private sendSeq = 0n;
  private recvSeq = 0n;
  private watchers: Array<() => void> = [];
  socket!: Socket;

  constructor(private readonly key: Uint8Array) {}

  static async connect(port: number, key: Uint8Array): Promise<SecureMockDevice> {
    const d = new SecureMockDevice(key);
    d.socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data: (_s, b) => d.onData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
        open() {},
        close: () => {
          d.closed = true;
          d.notify();
        },
        error() {},
      },
    });
    return d;
  }

  private onData(chunk: Uint8Array): void {
    this.rawBytes += chunk.length;
    this.rawInbound.push(chunk.slice());
    this.buf = concat(this.buf, chunk);
    if (this.epoch === null) {
      if (this.buf.length < EPOCH_BYTES) return;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, EPOCH_BYTES);
      this.epoch = view.getBigUint64(0, false);
      this.buf = this.buf.subarray(EPOCH_BYTES);
    }
    for (const record of this.recordDec.push(this.buf)) {
      const plain = openRecord(this.key, DIR_DOWN, this.epoch, this.recvSeq, record);
      if (!plain) throw new Error("device failed to open a host record");
      this.recvSeq += 1n;
      for (const f of this.frameDec.push(plain)) this.frames.push(f);
    }
    this.buf = new Uint8Array(0); // recordDec buffers any partial record
    this.notify();
  }

  /** Seal one frame as the next outbound record (consumes a send seq). */
  seal(type: number, sessionId: number, payload: unknown): Uint8Array {
    if (this.epoch === null) throw new Error("no epoch yet");
    const record = sealRecord(this.key, DIR_UP, this.epoch, this.sendSeq, encodeFrame(type, sessionId, payload));
    this.sendSeq += 1n;
    return lengthPrefix(record);
  }

  send(type: number, sessionId: number, payload: unknown): void {
    const wire = this.seal(type, sessionId, payload);
    this.rawOutbound.push(wire.slice());
    this.socket.write(wire);
  }

  sendRaw(bytes: Uint8Array): void {
    this.socket.write(bytes);
  }

  of(type: number): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }

  async waitFor(pred: () => boolean, ms = 1500): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
      await new Promise<void>((r) => this.watchers.push(r));
    }
  }

  private notify(): void {
    for (const w of this.watchers.splice(0)) w();
  }

  close(): void {
    this.socket.end();
  }
}

/** Poll for host-side state the device gets no wire event for. */
async function until(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await Bun.sleep(10);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe("psk config", () => {
  test("loadPsk parses a 64-hex-char key (trim, case-insensitive)", () => {
    const key = loadPsk({ SENDAI_PSK: `  ${PSK_HEX.toUpperCase()}\n` });
    expect(key).toEqual(PSK);
  });

  test("loadPsk returns null when unset or empty", () => {
    expect(loadPsk({})).toBeNull();
    expect(loadPsk({ SENDAI_PSK: "   " })).toBeNull();
  });

  test("loadPsk rejects malformed values with a clear message", () => {
    expect(() => loadPsk({ SENDAI_PSK: "abc123" })).toThrow(/SENDAI_PSK.*64 hex chars/);
    expect(() => loadPsk({ SENDAI_PSK: "zz".repeat(32) })).toThrow(/SENDAI_PSK/);
  });

  test("keyToHex round-trips keyFromHex", () => {
    expect(keyToHex(PSK)).toBe(PSK_HEX);
    expect(keyFromHex(keyToHex(WRONG_PSK))).toEqual(WRONG_PSK);
  });

  test("a PSK allows a non-loopback bind without a token", () => {
    expect(() => assertBindAllowed("0.0.0.0", undefined, PSK)).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", undefined, null)).toThrow(/non-loopback/);
  });
});

describe("secure transport", () => {
  test("sealed attach gets a sealed HELLO and the full prompt->output flow works", async () => {
    const host = await createHost({ host: "127.0.0.1", port: 0, token: "t", psk: PSK });
    const claude = new FakeAdapter("claude");
    const id = host.createSession("claude", "/a", claude);
    try {
      const dev = await SecureMockDevice.connect(host.port, PSK);
      await dev.waitFor(() => dev.epoch !== null);
      dev.send(MSG.ATTACH, 0, { token: "t" });
      await dev.waitFor(() => dev.of(MSG.HELLO).length > 0);
      await dev.waitFor(() => dev.of(MSG.SESSION_LIST).length > 0);

      dev.send(MSG.PROMPT_TEXT, id, { text: "do the thing" });
      await until(() => claude.prompts.length > 0);
      expect(claude.prompts).toEqual(["do the thing"]);

      claude.emit({ kind: "output", text: "done" });
      await dev.waitFor(() => dev.of(MSG.OUTPUT_CHUNK).length > 0);
      expect((dev.of(MSG.OUTPUT_CHUNK)[0]!.payload as { text: string }).text).toBe("done");
      dev.close();
    } finally {
      host.stop();
    }
  });


  test("AE4: nothing readable crosses the wire — prompts, tokens, output all sealed", async () => {
    const host = await createHost({ host: "127.0.0.1", port: 0, token: "super-secret-token", psk: PSK });
    const claude = new FakeAdapter("claude");
    const id = host.createSession("claude", "/a", claude);
    try {
      const dev = await SecureMockDevice.connect(host.port, PSK);
      await dev.waitFor(() => dev.epoch !== null);
      dev.send(MSG.ATTACH, 0, { token: "super-secret-token" });
      await dev.waitFor(() => dev.of(MSG.HELLO).length > 0);
      dev.send(MSG.PROMPT_TEXT, id, { text: "refactor the payment module" });
      await until(() => claude.prompts.length > 0);
      claude.emit({ kind: "output", text: "payment module refactored" });
      await dev.waitFor(() => dev.of(MSG.OUTPUT_CHUNK).length > 0);
      dev.close();

      // The machine-checkable form of AE4: reassemble every byte that crossed
      // the wire in both directions and assert no application plaintext —
      // token, prompt, output, or even JSON structure — appears anywhere.
      const wire = [...dev.rawInbound, ...dev.rawOutbound];
      const total = wire.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of wire) {
        all.set(c, off);
        off += c.length;
      }
      const text = new TextDecoder("latin1").decode(all);
      for (const secret of [
        "super-secret-token",
        "refactor the payment module",
        "payment module refactored",
        '"token"',
        '"text"',
        "3dsendai", // even the HELLO server name must be sealed
      ]) {
        expect(text.includes(secret)).toBe(false);
      }
      // Sanity: the device did receive real traffic, not nothing.
      expect(total).toBeGreaterThan(100);
    } finally {
      host.stop();
    }
  });

  test("wrong PSK: first record drops the connection, only the epoch leaks", async () => {
    let frames = 0;
    const server = await createServer(
      { host: "127.0.0.1", port: 0, token: "t", psk: PSK },
      { onFrame: () => frames++ },
    );
    try {
      const dev = await SecureMockDevice.connect(server.port, WRONG_PSK);
      await dev.waitFor(() => dev.epoch !== null);
      dev.send(MSG.ATTACH, 0, { token: "t" });
      await dev.waitFor(() => dev.closed);
      expect(dev.rawBytes).toBe(EPOCH_BYTES); // no error frame, plaintext or sealed
      expect(dev.frames.length).toBe(0);
      expect(frames).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("replayed record: same sealed bytes twice closes the connection", async () => {
    const seen: Frame[] = [];
    const server = await createServer(
      { host: "127.0.0.1", port: 0, token: "t", psk: PSK },
      { onFrame: (f) => seen.push(f) },
    );
    try {
      const dev = await SecureMockDevice.connect(server.port, PSK);
      await dev.waitFor(() => dev.epoch !== null);
      dev.send(MSG.ATTACH, 0, { token: "t" });
      await dev.waitFor(() => dev.of(MSG.HELLO).length > 0);

      const record = dev.seal(MSG.PROMPT_TEXT, 0, { text: "once" });
      dev.sendRaw(record);
      await until(() => seen.length === 1);
      dev.sendRaw(record); // replay: host expects seq 2, record was sealed at 1
      await dev.waitFor(() => dev.closed);
      expect(seen.length).toBe(1); // the replay never reached the app layer
    } finally {
      server.stop();
    }
  });

  test("oversized declared record length closes before buffering", async () => {
    const server = await createServer(
      { host: "127.0.0.1", port: 0, token: "t", psk: PSK },
      { onFrame: () => {} },
    );
    try {
      const dev = await SecureMockDevice.connect(server.port, PSK);
      await dev.waitFor(() => dev.epoch !== null);
      const evil: Uint8Array = new Uint8Array(8);
      new DataView(evil.buffer).setUint32(0, MAX_SECURE_RECORD + 1, false);
      dev.sendRaw(evil);
      await dev.waitFor(() => dev.closed);
      expect(dev.rawBytes).toBe(EPOCH_BYTES);
    } finally {
      server.stop();
    }
  });

  test("AE1 under PSK: reconnect with a fresh epoch replays via the ATTACH cursor", async () => {
    const host = await createHost({ host: "127.0.0.1", port: 0, token: "t", psk: PSK });
    const claude = new FakeAdapter("claude");
    host.createSession("claude", "/a", claude);
    try {
      const dev1 = await SecureMockDevice.connect(host.port, PSK);
      await dev1.waitFor(() => dev1.epoch !== null);
      dev1.send(MSG.ATTACH, 0, { token: "t" });
      await dev1.waitFor(() => dev1.of(MSG.SESSION_LIST).length > 0);
      claude.emit({ kind: "output", text: "before-disconnect" });
      await dev1.waitFor(() => dev1.of(MSG.OUTPUT_CHUNK).length >= 1);
      const cursor = host.registry.replay(0).latest;
      dev1.close();

      claude.emit({ kind: "output", text: "during-disconnect" });

      const dev2 = await SecureMockDevice.connect(host.port, PSK);
      await dev2.waitFor(() => dev2.epoch !== null);
      expect(dev2.epoch).not.toBe(dev1.epoch); // fresh epoch + counters per connection
      dev2.send(MSG.ATTACH, 0, { cursor, token: "t" });
      await dev2.waitFor(() => dev2.of(MSG.REPLAY_END).length > 0);
      const replayed = dev2.of(MSG.OUTPUT_CHUNK).map((f) => (f.payload as { text: string }).text);
      expect(replayed).toContain("during-disconnect");
      expect(replayed).not.toContain("before-disconnect");
      dev2.close();
    } finally {
      host.stop();
    }
  });

  test("no PSK configured: the plaintext path is untouched", async () => {
    // A plaintext client (raw frames, no epoch read) against a PSK-less server.
    const server = await createServer(
      { host: "127.0.0.1", port: 0, token: "t" },
      { onFrame: () => {} },
    );
    try {
      const dec = new FrameDecoder();
      const frames: Frame[] = [];
      const watchers: Array<() => void> = [];
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port: server.port,
        socket: {
          data(_s, b) {
            for (const f of dec.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))) frames.push(f);
            for (const w of watchers.splice(0)) w();
          },
          open() {},
          close() {},
          error() {},
        },
      });
      sock.write(encodeFrame(MSG.ATTACH, 0, { token: "t" }));
      const start = Date.now();
      while (!frames.some((f) => f.type === MSG.HELLO)) {
        if (Date.now() - start > 1500) throw new Error("timeout waiting for HELLO");
        await new Promise<void>((r) => watchers.push(r));
      }
      expect(frames[0]!.type).toBe(MSG.HELLO); // no epoch bytes precede it
      sock.end();
    } finally {
      server.stop();
    }
  });
});
