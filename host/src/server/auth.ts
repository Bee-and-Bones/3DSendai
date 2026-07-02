// Authentication is a v1 requirement, not deferred to M4 (deepening finding #1).
// The host executes agent tool calls, so a token gates every connection and the
// server binds loopback unless a token is configured.

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * A non-loopback bind requires a configured token or a PSK (U25); refuse
 * startup otherwise. A PSK is the stronger authenticator — every frame is
 * AEAD-sealed, so the token becomes secondary when one is set.
 */
export function assertBindAllowed(host: string, token: string | undefined, psk?: Uint8Array | null): void {
  if (!isLoopback(host) && !token && !psk) {
    throw new Error(
      `refusing non-loopback bind on ${host} without an auth token or PSK; set one or bind loopback`,
    );
  }
}

export interface AttachCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Verify an attach.
 * - If a token is configured, the device must present exactly that token.
 * - If no token is configured, only loopback binds reach here (enforced at
 *   startup by assertBindAllowed), so an unauthenticated loopback dev session
 *   is allowed.
 */
export function verifyAttach(expected: string | undefined, provided: string | undefined): AttachCheck {
  if (!expected) return { ok: true };
  if (!provided) return { ok: false, reason: "missing token" };
  if (provided !== expected) return { ok: false, reason: "invalid token" };
  return { ok: true };
}
