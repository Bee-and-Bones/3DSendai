import { expect, test, describe } from "bun:test";
import { Connection, type ByteSink } from "../src/server/connection.ts";
import { FrameDecoder, MSG, encodeFrame, type Frame } from "@agentbus/protocol";

/** A sink whose acceptance can be paused to simulate backpressure. */
class PausableSink implements ByteSink {
  received = new Uint8Array(0);
  paused = false;
  write(bytes: Uint8Array): number {
    if (this.paused) return 0;
    const out = new Uint8Array(this.received.length + bytes.length);
    out.set(this.received, 0);
    out.set(bytes, this.received.length);
    this.received = out;
    return bytes.length;
  }
  decode(): Frame[] {
    return new FrameDecoder().push(this.received);
  }
}

describe("connection", () => {
  test("sends frames that decode on the other end", () => {
    const sink = new PausableSink();
    const conn = new Connection(sink, () => {});
    conn.send(MSG.OUTPUT_CHUNK, 3, { text: "hi" });
    conn.send(MSG.SESSION_STATE, 3, { sessionId: 3 });
    const frames = sink.decode();
    expect(frames.map((f) => f.type)).toEqual([MSG.OUTPUT_CHUNK, MSG.SESSION_STATE]);
    expect(conn.queuedBytes).toBe(0);
  });

  test("applies backpressure without dropping or reordering frames", () => {
    const sink = new PausableSink();
    const conn = new Connection(sink, () => {});
    sink.paused = true;
    conn.send(MSG.OUTPUT_CHUNK, 1, { text: "a" });
    conn.send(MSG.OUTPUT_CHUNK, 1, { text: "b" });
    conn.send(MSG.OUTPUT_CHUNK, 1, { text: "c" });
    expect(conn.queuedBytes).toBeGreaterThan(0);
    expect(sink.received.length).toBe(0); // nothing accepted while paused

    sink.paused = false;
    conn.onDrain();
    expect(conn.queuedBytes).toBe(0);
    const texts = sink.decode().map((f) => (f.payload as { text: string }).text);
    expect(texts).toEqual(["a", "b", "c"]); // order preserved, none dropped
  });

  test("feeds inbound bytes and dispatches decoded frames", () => {
    const seen: Frame[] = [];
    const conn = new Connection({ write: (b) => b.length }, (frame) => seen.push(frame));
    conn.feed(encodeFrame(MSG.PROMPT_TEXT, 0, { text: "hello" }));
    expect(seen.length).toBe(1);
    expect(seen[0]!.type).toBe(MSG.PROMPT_TEXT);
    expect((seen[0]!.payload as { text: string }).text).toBe("hello");
  });
});
