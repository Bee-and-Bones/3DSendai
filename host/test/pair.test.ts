// U5 (plan-004) pair-mode tests: PSK minting, URI grammar round-trip, and QR
// encoder structure. Byte-exact decodability is proven cross-library by the
// U6 C KAT (vendored quirc decodes a matrix this encoder produced).

import { expect, test, describe } from "bun:test";
import { mintPsk, keyToHex } from "../src/psk.ts";
import { composePairUri, parsePairUri, runPairMode } from "../src/pair.ts";
import { qrEncode, qrCapacity, qrToLuma, qrToTerminal } from "../src/qr.ts";

describe("pair mode (U5)", () => {
  test("minted PSK is 64 lowercase hex chars and non-degenerate", () => {
    const hex = keyToHex(mintPsk());
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).not.toBe("0".repeat(64));
    expect(keyToHex(mintPsk())).not.toBe(hex); // two mints differ
  });

  test("URI round-trips psk/host/port/token", () => {
    const info = { psk: "ab".repeat(32), host: "192.168.1.10", port: 4791, token: "t0ken" };
    const uri = composePairUri(info);
    expect(uri).toBe(`3dsendai://${"ab".repeat(32)}@192.168.1.10:4791?token=t0ken`);
    expect(parsePairUri(uri)).toEqual(info);
  });

  test("host absent: URI omits host and parses back without one (discovery)", () => {
    const info = { psk: "cd".repeat(32) };
    const uri = composePairUri(info);
    expect(uri).toBe(`3dsendai://${"cd".repeat(32)}`);
    expect(parsePairUri(uri)).toEqual({ psk: "cd".repeat(32), host: undefined, port: undefined, token: undefined });
  });

  test("malformed URIs are rejected", () => {
    expect(parsePairUri("http://aa@x:1")).toBeNull(); // wrong scheme
    expect(parsePairUri("3dsendai://" + "a".repeat(63))).toBeNull(); // short psk
    expect(parsePairUri("3dsendai://" + "g".repeat(64))).toBeNull(); // non-hex psk
    expect(parsePairUri(`3dsendai://${"ab".repeat(32)}@host:0`)).toBeNull(); // bad port
    expect(parsePairUri(`3dsendai://${"ab".repeat(32)}@host:99999`)).toBeNull();
    expect(parsePairUri(`3dsendai://${"ab".repeat(32)}@nocolon`)).toBeNull();
    expect(parsePairUri(`3dsendai://${"ab".repeat(32)}?token=`)).toBeNull(); // empty token
  });

  test("runPairMode prints a QR block, the URI, and the PSK fallback", () => {
    const lines: string[] = [];
    const info = runPairMode({ host: "10.0.0.2", port: 4791, token: "tok", print: (l) => lines.push(l) });
    expect(info.psk).toMatch(/^[0-9a-f]{64}$/);
    const out = lines.join("\n");
    expect(out).toContain("▄"); // half-block QR rendering present
    expect(out).toContain(`3dsendai://${info.psk}@10.0.0.2:4791?token=tok`);
    expect(out).toContain(info.psk);
  });
});

describe("qr encoder (U5)", () => {
  test("version selection matches capacity table", () => {
    expect(qrCapacity(1)).toBe(17);
    expect(qrCapacity(5)).toBe(106);
    expect(qrCapacity(6)).toBe(134);
    expect(qrEncode("x".repeat(17)).version).toBe(1);
    expect(qrEncode("x".repeat(18)).version).toBe(2);
    expect(qrEncode("x".repeat(120)).version).toBe(6);
    expect(() => qrEncode("x".repeat(272))).toThrow(/too long/);
  });

  test("matrix has the right size and finder patterns in all three corners", () => {
    const qr = qrEncode("3dsendai://" + "ab".repeat(32));
    expect(qr.size).toBe(17 + 4 * qr.version);
    const m = qr.modules;
    for (const [r0, c0] of [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]] as const) {
      // 7x7 finder: dark border ring + dark 3x3 center, light in between.
      expect(m[r0]![c0]).toBe(true);
      expect(m[r0]![c0 + 6]).toBe(true);
      expect(m[r0 + 6]![c0]).toBe(true);
      expect(m[r0 + 3]![c0 + 3]).toBe(true); // center
      expect(m[r0 + 1]![c0 + 1]).toBe(false); // inner light ring
    }
    // Timing pattern alternates.
    expect(m[6]![8]).toBe(true);
    expect(m[6]![9]).toBe(false);
  });

  test("encoding is deterministic and mask is in range", () => {
    const a = qrEncode("hello");
    const b = qrEncode("hello");
    expect(a.mask).toBeGreaterThanOrEqual(0);
    expect(a.mask).toBeLessThanOrEqual(7);
    expect(a.modules).toEqual(b.modules);
  });

  test("luma render: dark module -> 0, quiet zone -> 255, correct dims", () => {
    const qr = qrEncode("hello");
    const { width, height, pixels } = qrToLuma(qr, 4);
    expect(width).toBe((qr.size + 8) * 4);
    expect(height).toBe(width);
    expect(pixels[0]).toBe(255); // quiet zone corner
    // Top-left finder corner module is dark: pixel at (16,16).
    expect(pixels[16 * width + 16]).toBe(0);
  });

  test("terminal render has quiet-zone rows and expected line count", () => {
    const qr = qrEncode("hello");
    const lines = qrToTerminal(qr).split("\n");
    expect(lines.length).toBe(Math.ceil((qr.size + 4) / 2));
    expect(lines[0]).toBe("█".repeat(qr.size + 4)); // top quiet zone: all light
  });
});
