import { expect, test, describe } from "bun:test";
import { DurableBuffer } from "../src/registry/durable.ts";
import { MSG } from "@agentbus/protocol";

describe("durable buffer", () => {
  test("replays everything after a cursor", () => {
    const b = new DurableBuffer();
    b.record(MSG.OUTPUT_CHUNK, 1, { text: "a" });
    b.record(MSG.OUTPUT_CHUNK, 1, { text: "b" });
    b.record(MSG.OUTPUT_CHUNK, 1, { text: "c" });
    const r = b.replaySince(0);
    expect(r.frames.map((f) => (f.payload as { text: string }).text)).toEqual(["a", "b", "c"]);
    expect(r.truncated).toBe(false);
    expect(r.latest).toBe(3);
  });

  test("replays only frames strictly after the cursor", () => {
    const b = new DurableBuffer();
    b.record(MSG.OUTPUT_CHUNK, 1, { text: "a" });
    const seq = b.record(MSG.OUTPUT_CHUNK, 1, { text: "b" });
    b.record(MSG.OUTPUT_CHUNK, 1, { text: "c" });
    const r = b.replaySince(seq);
    expect(r.frames.map((f) => (f.payload as { text: string }).text)).toEqual(["c"]);
    expect(r.truncated).toBe(false);
  });

  test("flags truncation when the disconnect outran the buffer", () => {
    const b = new DurableBuffer(3);
    for (const t of ["a", "b", "c", "d", "e"]) b.record(MSG.OUTPUT_CHUNK, 1, { text: t });
    const r = b.replaySince(0); // 0 is older than what we still retain
    expect(r.truncated).toBe(true);
    expect(r.frames.map((f) => (f.payload as { text: string }).text)).toEqual(["c", "d", "e"]);
    expect(r.latest).toBe(5);
  });

  test("a fresh cursor at latest replays nothing and is not truncated", () => {
    const b = new DurableBuffer(3);
    for (const t of ["a", "b", "c", "d"]) b.record(MSG.OUTPUT_CHUNK, 1, { text: t });
    const r = b.replaySince(b.latest);
    expect(r.frames).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
