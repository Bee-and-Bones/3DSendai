import { expect, test, describe } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_LEN,
  MSG,
  AGENTBUS_VERSION,
  isKnownType,
  typeName,
  isCompatibleHello,
  canonicalJSON,
} from "../src/index.ts";

function decodeOne(bytes: Uint8Array) {
  const frames = new FrameDecoder().push(bytes);
  expect(frames.length).toBe(1);
  return frames[0]!;
}

describe("frame codec", () => {
  test("round-trips each representative message type", () => {
    const samples: Array<[number, number, unknown]> = [
      [MSG.HELLO, 0, { version: AGENTBUS_VERSION, server: "3dsendai" }],
      [MSG.PROMPT_TEXT, 0, { text: "hi" }],
      [MSG.OUTPUT_CHUNK, 5, { text: "streamed" }],
      [MSG.APPROVAL_REQUEST, 3, { approvalId: "a1", tool: "Bash", detail: "ls", risk: "low" }],
      [MSG.ATTACH, 0, { token: "t", cursor: 9 }],
      [MSG.CLIENT_SIZE, 0, { cols: 50, rows: 24 }],
    ];
    for (const [type, sid, payload] of samples) {
      const frame = decodeOne(encodeFrame(type, sid, payload));
      expect(frame.type).toBe(type);
      expect(frame.sessionId).toBe(sid);
      expect(frame.payload).toEqual(payload);
    }
  });

  test("reassembles a frame split across two reads", () => {
    const bytes = encodeFrame(MSG.OUTPUT_CHUNK, 1, { text: "hello world" });
    const d = new FrameDecoder();
    const cut = 7;
    expect(d.push(bytes.subarray(0, cut))).toEqual([]);
    expect(d.pending).toBe(cut);
    const frames = d.push(bytes.subarray(cut));
    expect(frames.length).toBe(1);
    expect(frames[0]!.payload).toEqual({ text: "hello world" });
    expect(d.pending).toBe(0);
  });

  test("decodes two frames delivered in one buffer, in order", () => {
    const a = encodeFrame(MSG.OUTPUT_CHUNK, 1, { text: "first" });
    const b = encodeFrame(MSG.OUTPUT_CHUNK, 1, { text: "second" });
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    const frames = new FrameDecoder().push(merged);
    expect(frames.map((f) => (f.payload as { text: string }).text)).toEqual(["first", "second"]);
  });

  test("rejects an oversized length header without allocating", () => {
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, MAX_FRAME_LEN + 1, false);
    expect(() => new FrameDecoder().push(bad)).toThrow(/too large/);
  });

  test("rejects a body length shorter than the envelope", () => {
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 3, false); // < type+sessionId (5)
    expect(() => new FrameDecoder().push(bad)).toThrow(/too short/);
  });

  test("unknown message type still decodes (forward-compat)", () => {
    const frame = decodeOne(encodeFrame(200, 0, { future: true }));
    expect(frame.type).toBe(200);
    expect(isKnownType(frame.type)).toBe(false);
    expect(typeName(frame.type)).toBeUndefined();
    expect(frame.payload).toEqual({ future: true });
  });

  test("client_size with zero/absurd dims still decodes (host clamps later)", () => {
    for (const payload of [{ cols: 0, rows: 0 }, { cols: 100000, rows: -3 }]) {
      const frame = decodeOne(encodeFrame(MSG.CLIENT_SIZE, 0, payload));
      expect(frame.type).toBe(MSG.CLIENT_SIZE);
      expect(frame.payload).toEqual(payload);
    }
  });

  test("known type names resolve", () => {
    expect(typeName(MSG.APPROVAL_REQUEST)).toBe("APPROVAL_REQUEST");
    expect(isKnownType(MSG.ATTACH)).toBe(true);
  });

  test("invalid payload json throws", () => {
    // hand-build a frame with non-json body
    const body = new TextEncoder().encode("not json");
    const buf = new Uint8Array(4 + 5 + body.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 5 + body.length, false);
    buf[4] = MSG.OUTPUT_CHUNK;
    view.setUint32(5, 0, false);
    buf.set(body, 9);
    expect(() => new FrameDecoder().push(buf)).toThrow(/payload json/);
  });

  test("version mismatch in hello is detected", () => {
    expect(isCompatibleHello({ version: AGENTBUS_VERSION, server: "x" })).toBe(true);
    expect(isCompatibleHello({ version: AGENTBUS_VERSION + 1, server: "x" })).toBe(false);
  });

  test("canonical json sorts keys deterministically", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJSON({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  test("out-of-range type and session id are rejected on encode", () => {
    expect(() => encodeFrame(-1, 0, {})).toThrow(/type/);
    expect(() => encodeFrame(300, 0, {})).toThrow(/type/);
    expect(() => encodeFrame(MSG.HELLO, -1, {})).toThrow(/session/);
  });
});
