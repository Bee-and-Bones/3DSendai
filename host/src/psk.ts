// PSK loading for the encrypted transport (U25). AG3NT_PSK is a 32-byte
// XChaCha20-Poly1305 key encoded as 64 hex chars; unset means plaintext
// loopback dev mode (token auth only).

import { KEY_BYTES } from "@agentbus/protocol";

const HEX_CHARS = KEY_BYTES * 2;

/** Decode a 64-hex-char key. Trims whitespace, case-insensitive. */
export function keyFromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length !== HEX_CHARS || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error(
      `PSK must be exactly ${HEX_CHARS} hex chars (${KEY_BYTES} bytes), got ${clean.length} chars` +
        (/^[0-9a-f]*$/.test(clean) ? "" : " with non-hex characters"),
    );
  }
  const key: Uint8Array = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i++) {
    key[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return key;
}

/** Encode a key as lowercase hex (for display/config generation). */
export function keyToHex(key: Uint8Array): string {
  let out = "";
  for (const byte of key) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Read AG3NT_PSK from env. Null when unset/empty; throws on a malformed value. */
export function loadPsk(env: Record<string, string | undefined>): Uint8Array | null {
  const raw = env.AG3NT_PSK;
  if (!raw || raw.trim().length === 0) return null;
  try {
    return keyFromHex(raw);
  } catch (err) {
    throw new Error(`invalid AG3NT_PSK: ${(err as Error).message}`);
  }
}
