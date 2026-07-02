import { beforeAll, expect, test } from "bun:test";
import { cryptoReady, encrypt, decrypt } from "../src/crypto.ts";
import { fromHex, toHex } from "../src/frames.ts";

// Cross-library known-answer test (U23). The SAME fixture and expected hex are
// asserted by client/test/crypto_test.c against Monocypher. If libsodium and
// Monocypher ever disagree on these bytes, one of the two suites fails.
//
//   key   = 00..1f
//   nonce = 40..57
//   aad   = "3dsendai-kat"
//   pt    = "3dsendai KAT v1"
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const NONCE = Uint8Array.from({ length: 24 }, (_, i) => 0x40 + i);
const AAD = new TextEncoder().encode("3dsendai-kat");
const PT = new TextEncoder().encode("3dsendai KAT v1");
const SEALED_HEX = "e75d7615be84187fafbfc6ea8fea54b5b27457eb68aaef7e2336a7c52d6f71";

beforeAll(async () => {
  await cryptoReady();
});

test("AEAD KAT: libsodium reproduces the fixed vector", () => {
  expect(toHex(encrypt(KEY, NONCE, AAD, PT))).toBe(SEALED_HEX);
});

test("round-trip encrypt -> decrypt returns plaintext", () => {
  const sealed = encrypt(KEY, NONCE, AAD, PT);
  expect(decrypt(KEY, NONCE, AAD, sealed)).toEqual(PT);
});

test("tampered MAC is rejected", () => {
  const sealed = encrypt(KEY, NONCE, AAD, PT);
  sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x01;
  expect(decrypt(KEY, NONCE, AAD, sealed)).toBeNull();
});

test("wrong key is rejected", () => {
  const sealed = encrypt(KEY, NONCE, AAD, PT);
  const wrong = KEY.slice();
  wrong[0] = (wrong[0] ?? 0) ^ 0xff;
  expect(decrypt(wrong, NONCE, AAD, sealed)).toBeNull();
});

test("wrong AAD is rejected", () => {
  const sealed = encrypt(KEY, NONCE, AAD, PT);
  expect(decrypt(KEY, NONCE, new TextEncoder().encode("3dsendai-xxx"), sealed)).toBeNull();
});

test("decrypt of a fixed sealed vector yields the plaintext", () => {
  expect(decrypt(KEY, NONCE, AAD, fromHex(SEALED_HEX))).toEqual(PT);
});

test("wrong-size key throws", () => {
  expect(() => encrypt(KEY.slice(0, 16), NONCE, AAD, PT)).toThrow();
});
