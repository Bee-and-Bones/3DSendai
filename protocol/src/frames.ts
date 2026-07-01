// AgentBus wire framing.
//
// Frame layout: [u32 length BE][u8 type][u32 session_id BE][json payload bytes]
// - `length` counts everything after itself (1 + 4 + payloadBytes).
// - session_id is 0 for the M1 single session; the field is reserved in the
//   envelope up front so M2 multiplexing is an additive fill, not a rewrite.
// - payload is canonical JSON (sorted keys, no whitespace) for byte-exact
//   golden vectors and easy C-side mirroring (cJSON), per the U2 decision.

export const HEADER_LEN = 4; // u32 length prefix
export const MIN_BODY_LEN = 1 + 4; // type + session_id
export const MAX_FRAME_LEN = 4 * 1024 * 1024; // 4 MiB guard

export interface Frame {
  type: number;
  sessionId: number;
  payload: unknown;
}

/** Recursively key-sorted JSON with no whitespace. Deterministic on the wire. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(type: number, sessionId: number, payload: unknown): Uint8Array {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new RangeError(`frame type out of range: ${type}`);
  }
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) {
    throw new RangeError(`session id out of range: ${sessionId}`);
  }
  const json = enc.encode(canonicalJSON(payload));
  const bodyLen = MIN_BODY_LEN + json.length;
  if (bodyLen > MAX_FRAME_LEN) throw new RangeError(`frame too large: ${bodyLen}`);

  const buf = new Uint8Array(HEADER_LEN + bodyLen);
  const view = new DataView(buf.buffer);
  view.setUint32(0, bodyLen, false);
  buf[4] = type;
  view.setUint32(5, sessionId, false);
  buf.set(json, 9);
  return buf;
}

/**
 * Streaming frame decoder. Feed arbitrary byte chunks; get back whole frames.
 * Handles frames split across reads and multiple frames in one read.
 * Throws on an oversized or malformed length header (caller closes the conn).
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    this.buf = concat(this.buf, chunk);
    const frames: Frame[] = [];

    for (;;) {
      if (this.buf.length < HEADER_LEN) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const bodyLen = view.getUint32(0, false);

      if (bodyLen < MIN_BODY_LEN) throw new RangeError(`frame body too short: ${bodyLen}`);
      if (bodyLen > MAX_FRAME_LEN) throw new RangeError(`frame too large: ${bodyLen}`);

      const total = HEADER_LEN + bodyLen;
      if (this.buf.length < total) break; // wait for more bytes

      const type = this.buf[4]!;
      const sessionId = view.getUint32(5, false);
      const jsonBytes = this.buf.subarray(9, total);
      let payload: unknown;
      try {
        payload = JSON.parse(dec.decode(jsonBytes));
      } catch (err) {
        throw new SyntaxError(`invalid frame payload json: ${(err as Error).message}`);
      }
      frames.push({ type, sessionId, payload });
      this.buf = this.buf.subarray(total);
    }
    return frames;
  }

  /** Bytes buffered but not yet a complete frame (for tests/diagnostics). */
  get pending(): number {
    return this.buf.length;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
