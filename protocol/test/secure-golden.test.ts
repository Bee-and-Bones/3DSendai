import { beforeAll, expect, test } from "bun:test";
import { cryptoReady } from "../src/crypto.ts";
import { sealRecord, openRecord } from "../src/secure-frame.ts";
import { fromHex, toHex } from "../src/frames.ts";
import vectors from "./golden/secure-vectors.json";

// Byte-exact secure-transport vectors (U24), the encrypted sibling of
// golden.test.ts. The same hex constants are asserted against Monocypher in
// client/test/frame_test.c and discovery_test.c — this is the cross-library
// interop gate for the full record layout (AAD + nonce placement + mac).

const KEY = fromHex(vectors.key_hex);

beforeAll(async () => {
  await cryptoReady();
});

for (const v of vectors.vectors) {
  test(`${v.name}: seal produces the exact record bytes`, () => {
    const rec = sealRecord(
      KEY,
      v.dir,
      BigInt("0x" + v.epoch_hex),
      BigInt(v.seq),
      fromHex(v.plaintext_hex),
      fromHex(v.nonce_hex),
      v.context,
    );
    expect(toHex(rec)).toBe(v.record_hex);
  });

  test(`${v.name}: open recovers the exact plaintext`, () => {
    const plain = openRecord(
      KEY,
      v.dir,
      BigInt("0x" + v.epoch_hex),
      BigInt(v.seq),
      fromHex(v.record_hex),
      v.context,
    );
    expect(plain).not.toBeNull();
    expect(toHex(plain as Uint8Array)).toBe(v.plaintext_hex);
  });
}
