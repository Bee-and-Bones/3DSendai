import { beforeAll, describe, expect, test } from "bun:test";
import { cryptoReady } from "../src/crypto.ts";
import {
  buildAad,
  sealRecord,
  openRecord,
  lengthPrefix,
  SecureRecordDecoder,
  SECURE_OVERHEAD,
  MAX_SECURE_RECORD,
} from "../src/secureFrame.ts";
import { encodeFrame, toHex } from "../src/frames.ts";
import { MSG } from "../src/message-types.generated.ts";
import { DIR_UP, DIR_DOWN, AAD_DSC_CONTEXT } from "../src/crypto-constants.generated.ts";

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const EPOCH = 0x1122334455667788n;
const FRAME = encodeFrame(MSG.PROMPT_TEXT, 0, { text: "fix the tests" });

beforeAll(async () => {
  await cryptoReady();
});

describe("AAD layout", () => {
  test("context ‖ dir ‖ epoch ‖ seq, big-endian, 32 bytes", () => {
    const aad = buildAad("3dsendai-msg-v1", DIR_UP, EPOCH, 0x0102n);
    expect(aad.length).toBe(32);
    expect(new TextDecoder().decode(aad.subarray(0, 15))).toBe("3dsendai-msg-v1");
    expect(aad[15]).toBe(DIR_UP);
    expect(toHex(aad.subarray(16, 24))).toBe("1122334455667788");
    expect(toHex(aad.subarray(24))).toBe("0000000000000102");
  });
});

describe("seal/open", () => {
  test("round-trip returns the exact frame bytes", () => {
    const rec = sealRecord(KEY, DIR_UP, EPOCH, 0n, FRAME);
    expect(openRecord(KEY, DIR_UP, EPOCH, 0n, rec)).toEqual(FRAME);
  });

  test("wrong seq (replay/reorder) is rejected", () => {
    const rec = sealRecord(KEY, DIR_UP, EPOCH, 5n, FRAME);
    expect(openRecord(KEY, DIR_UP, EPOCH, 6n, rec)).toBeNull();
    expect(openRecord(KEY, DIR_UP, EPOCH, 4n, rec)).toBeNull();
  });

  test("wrong dir (reflection) is rejected", () => {
    const rec = sealRecord(KEY, DIR_UP, EPOCH, 0n, FRAME);
    expect(openRecord(KEY, DIR_DOWN, EPOCH, 0n, rec)).toBeNull();
  });

  test("wrong epoch (cross-session replay) is rejected", () => {
    const rec = sealRecord(KEY, DIR_UP, EPOCH, 0n, FRAME);
    expect(openRecord(KEY, DIR_UP, EPOCH + 1n, 0n, rec)).toBeNull();
  });

  test("cross-context splice (discovery vs msg) is rejected", () => {
    const rec = sealRecord(KEY, DIR_UP, 0n, 0n, FRAME, undefined, AAD_DSC_CONTEXT);
    expect(openRecord(KEY, DIR_UP, 0n, 0n, rec)).toBeNull(); // opened under msg context
  });

  test("any tampered byte is rejected", () => {
    const rec = sealRecord(KEY, DIR_UP, EPOCH, 0n, FRAME);
    for (const i of [0, 24, rec.length - 1]) {
      const bad = rec.slice();
      bad[i] = (bad[i] ?? 0) ^ 0x80;
      expect(openRecord(KEY, DIR_UP, EPOCH, 0n, bad)).toBeNull();
    }
  });

  test("record shorter than overhead is rejected", () => {
    expect(openRecord(KEY, DIR_UP, EPOCH, 0n, new Uint8Array(SECURE_OVERHEAD - 1))).toBeNull();
  });
});

describe("SecureRecordDecoder", () => {
  test("single record round-trips through the length prefix", () => {
    const rec = sealRecord(KEY, DIR_UP, EPOCH, 0n, FRAME);
    const dec = new SecureRecordDecoder();
    const out = dec.push(lengthPrefix(rec));
    expect(out.length).toBe(1);
    expect(out[0]).toEqual(rec);
    expect(dec.pending).toBe(0);
  });

  test("two records coalesced in one chunk both emerge", () => {
    const a = sealRecord(KEY, DIR_UP, EPOCH, 0n, FRAME);
    const b = sealRecord(KEY, DIR_UP, EPOCH, 1n, FRAME);
    const joined = new Uint8Array([...lengthPrefix(a), ...lengthPrefix(b)]);
    const dec = new SecureRecordDecoder();
    const out = dec.push(joined);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual(a);
    expect(out[1]).toEqual(b);
  });

  test("partial record is retained until completed", () => {
    const rec = sealRecord(KEY, DIR_UP, EPOCH, 0n, FRAME);
    const wire = lengthPrefix(rec);
    const dec = new SecureRecordDecoder();
    expect(dec.push(wire.subarray(0, 10)).length).toBe(0);
    expect(dec.pending).toBe(10);
    const out = dec.push(wire.subarray(10));
    expect(out.length).toBe(1);
    expect(out[0]).toEqual(rec);
  });

  test("zero-length record throws (caller closes)", () => {
    const dec = new SecureRecordDecoder();
    expect(() => dec.push(new Uint8Array([0, 0, 0, 0]))).toThrow(RangeError);
  });

  test("oversized declared length throws before buffering", () => {
    const dec = new SecureRecordDecoder();
    const hdr = new Uint8Array(4);
    new DataView(hdr.buffer).setUint32(0, MAX_SECURE_RECORD + 1, false);
    expect(() => dec.push(hdr)).toThrow(RangeError);
  });
});
