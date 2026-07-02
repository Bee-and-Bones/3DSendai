import { expect, test, describe } from "bun:test";
import type { Socket } from "bun";
import { createServer } from "../src/server/index.ts";
import { MSG, FrameDecoder, encodeFrame, type Frame } from "@agentbus/protocol";

class TestClient {
  private dec = new FrameDecoder();
  readonly frames: Frame[] = [];
  private waiters: Array<{ type: number; resolve: (f: Frame) => void; timer: Timer }> = [];
  socket!: Socket;

  static async connect(port: number): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data: (_s, buf) => c.onData(buf),
        open() {},
        close() {},
        error() {},
      },
    });
    return c;
  }

  private onData(buf: Uint8Array): void {
    for (const f of this.dec.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))) {
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => {
        if (w.type === f.type) {
          clearTimeout(w.timer);
          w.resolve(f);
          return false;
        }
        return true;
      });
    }
  }

  send(type: number, sessionId: number, payload: unknown): void {
    this.socket.write(encodeFrame(type, sessionId, payload));
  }

  waitFor(type: number, ms = 1000): Promise<Frame> {
    const existing = this.frames.find((f) => f.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for type ${type}`)), ms);
      this.waiters.push({ type, resolve, timer });
    });
  }

  close(): void {
    this.socket.end();
  }
}

describe("AgentBus server", () => {
  test("accepts a valid token, greets, and forwards post-attach frames", async () => {
    let attaches = 0;
    let gotPrompt: (f: Frame) => void;
    const promptSeen = new Promise<Frame>((r) => (gotPrompt = r));
    const server = await createServer(
      { host: "127.0.0.1", port: 0, token: "secret" },
      { onAttach: () => attaches++, onFrame: (frame) => gotPrompt(frame) },
    );
    try {
      const client = await TestClient.connect(server.port);
      client.send(MSG.ATTACH, 0, { token: "secret" });
      const hello = await client.waitFor(MSG.HELLO);
      expect((hello.payload as { server: string }).server).toBe("ag3nt");
      client.send(MSG.PROMPT_TEXT, 0, { text: "hi" });
      const frame = await promptSeen;
      expect(frame.type).toBe(MSG.PROMPT_TEXT);
      expect((frame.payload as { text: string }).text).toBe("hi");
      expect(attaches).toBe(1);
      client.close();
    } finally {
      server.stop();
    }
  });

  test("rejects a wrong token before any frame is processed", async () => {
    let attaches = 0;
    let frames = 0;
    const server = await createServer(
      { host: "127.0.0.1", port: 0, token: "secret" },
      { onAttach: () => attaches++, onFrame: () => frames++ },
    );
    try {
      const client = await TestClient.connect(server.port);
      client.send(MSG.ATTACH, 0, { token: "wrong" });
      const err = await client.waitFor(MSG.ERROR);
      expect((err.payload as { message: string }).message).toMatch(/invalid token/);
      expect(attaches).toBe(0);
      expect(frames).toBe(0);
      client.close();
    } finally {
      server.stop();
    }
  });

  test("rejects a first frame that is not attach", async () => {
    const server = await createServer(
      { host: "127.0.0.1", port: 0, token: "secret" },
      { onFrame: () => {} },
    );
    try {
      const client = await TestClient.connect(server.port);
      client.send(MSG.PROMPT_TEXT, 0, { text: "no attach" });
      const err = await client.waitFor(MSG.ERROR);
      expect((err.payload as { message: string }).message).toMatch(/expected attach/);
      client.close();
    } finally {
      server.stop();
    }
  });

  test("refuses a non-loopback bind without a token", async () => {
    await expect(createServer({ host: "0.0.0.0", port: 0 }, { onFrame: () => {} })).rejects.toThrow(/non-loopback/);
  });
});
