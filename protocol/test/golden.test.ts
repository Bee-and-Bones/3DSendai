import { expect, test } from "bun:test";
import { encodeFrame, FrameDecoder, toHex, fromHex } from "../src/index.ts";
import vectors from "./golden/vectors.json" with { type: "json" };

interface Vector {
  name: string;
  type: number;
  sessionId: number;
  payload: unknown;
  hex: string;
}

// Byte-exact wire fixtures. Drift in framing/canonicalisation fails here rather
// than surfacing on-device. A C harness must match the same bytes (future work).
test.each(vectors as Vector[])("golden vector: $name encodes to exact bytes", (v) => {
  expect(toHex(encodeFrame(v.type, v.sessionId, v.payload))).toBe(v.hex);
});

test.each(vectors as Vector[])("golden vector: $name decodes from exact bytes", (v) => {
  const frames = new FrameDecoder().push(fromHex(v.hex));
  expect(frames.length).toBe(1);
  expect(frames[0]!.type).toBe(v.type);
  expect(frames[0]!.sessionId).toBe(v.sessionId);
  expect(frames[0]!.payload).toEqual(v.payload);
});
