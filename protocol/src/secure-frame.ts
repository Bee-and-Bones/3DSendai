// Secure framing for AgentBus (U24).
//
// Each plaintext AgentBus frame ([u32 len][u8 type][u32 sid][json]) is sealed
// as one AEAD record:  nonce(24) ‖ ciphertext(N) ‖ mac(16),
// carried on TCP under an outer [u32 len BE] prefix (len = 24 + N + 16).
//
// AAD (authenticated, never transmitted):
//   context(12) ‖ dir(1) ‖ epoch(8 BE) ‖ seq(8 BE)
// - context: "ag3nt-msg-v1" for TCP frames, "ag3nt-dsc-v1" for discovery —
//   domain separation so a captured datagram can't be spliced into a stream.
// - dir: 0x00 host->device, 0x01 device->host — blocks reflection.
// - epoch: random per-connection value the host mints at accept; defeats
//   cross-session replay. 0n on the plaintext/dev path.
// - seq: per-direction monotonic counter. The receiver decrypts against its
//   OWN expected counter — no seq travels on the wire, so any replay, reorder,
//   or splice fails the Poly1305 tag.
//
// The C client mirrors this layout in client/source/crypto.c; golden vectors
// in protocol/test/golden/secure-vectors.json keep both byte-exact.

import { encrypt, decrypt } from "./crypto.ts";
import {
  NONCE_BYTES,
  MAC_BYTES,
  AAD_MSG_CONTEXT,
} from "./crypto-constants.generated.ts";

export const SECURE_OVERHEAD = NONCE_BYTES + MAC_BYTES; // 40
// Records carry one AgentBus frame; the C client's receive buffer is 16 KiB,
// so the host must never seal a record the device can't buffer. 16 KiB minus
// slack for the outer prefix keeps both sides honest.
export const MAX_SECURE_RECORD = 16 * 1024;

const enc = new TextEncoder();

/** Build the 29-byte AAD: context(12) ‖ dir(1) ‖ epoch(8 BE) ‖ seq(8 BE). */
export function buildAad(context: string, dir: number, epoch: bigint, seq: bigint): Uint8Array {
  const ctx = enc.encode(context);
  const aad: Uint8Array = new Uint8Array(ctx.length + 1 + 8 + 8);
  aad.set(ctx, 0);
  aad[ctx.length] = dir;
  const view = new DataView(aad.buffer);
  view.setBigUint64(ctx.length + 1, epoch, false);
  view.setBigUint64(ctx.length + 9, seq, false);
  return aad;
}

/**
 * Seal one plaintext frame into a record: nonce ‖ ct ‖ mac.
 * `nonce` is injectable for tests/golden vectors only — production callers
 * omit it and get a fresh random 24-byte nonce per record.
 */
export function sealRecord(
  key: Uint8Array,
  dir: number,
  epoch: bigint,
  seq: bigint,
  plaintext: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
  context: string = AAD_MSG_CONTEXT,
): Uint8Array {
  const sealed = encrypt(key, nonce, buildAad(context, dir, epoch, seq), plaintext);
  const out: Uint8Array = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES); // libsodium output is ct‖mac — already wire order
  return out;
}

/** Open one record against the receiver's expected counters. Null on any failure. */
export function openRecord(
  key: Uint8Array,
  dir: number,
  epoch: bigint,
  seq: bigint,
  record: Uint8Array,
  context: string = AAD_MSG_CONTEXT,
): Uint8Array | null {
  if (record.length < SECURE_OVERHEAD) return null;
  const nonce = record.subarray(0, NONCE_BYTES);
  const sealed = record.subarray(NONCE_BYTES); // ct‖mac
  return decrypt(key, nonce, buildAad(context, dir, epoch, seq), sealed);
}

/**
 * Streaming decoder for the outer [u32 len BE][record] layer. Yields sealed
 * records; the transport opens each against its own recv counter. Throws on a
 * zero/oversized declared length so the caller closes the connection BEFORE
 * buffering attacker-declared bytes (the host is the exposed listener).
 */
export class SecureRecordDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = concat(this.buf, chunk);
    const records: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = view.getUint32(0, false);
      if (len < SECURE_OVERHEAD) throw new RangeError(`secure record too short: ${len}`);
      if (len > MAX_SECURE_RECORD) throw new RangeError(`secure record too large: ${len}`);
      const total = 4 + len;
      if (this.buf.length < total) break;
      records.push(this.buf.subarray(4, total));
      this.buf = this.buf.subarray(total);
    }
    return records;
  }

  get pending(): number {
    return this.buf.length;
  }
}

/** Prefix a sealed record with its u32 BE length for TCP. */
export function lengthPrefix(record: Uint8Array): Uint8Array {
  const out: Uint8Array = new Uint8Array(4 + record.length);
  new DataView(out.buffer).setUint32(0, record.length, false);
  out.set(record, 4);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
