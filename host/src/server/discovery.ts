// Zero-config UDP discovery, host responder (U27, R21).
//
// The 3DS broadcasts a probe to 255.255.255.255:41337; a host holding the
// same PSK replies unicast with `challenge(8) ‖ tcpPort(2 BE)` so the device
// learns the host IP (datagram source) and TCP port without a hardcoded
// SERVER_HOST. Datagram layout:
//
//   MAGIC "ag3n"(4) ‖ TYPE(1) ‖ sealed record (nonce24 ‖ ct ‖ mac16)
//
// Records are sealed under the DISCOVERY AAD context ("ag3nt-dsc-v1"),
// epoch 0, seq 0 — domain-separated from TCP frames so a captured datagram
// can never be spliced into a stream (and vice versa). Wrong-key or garbage
// datagrams are ignored: a passive scanner gets nothing back.
//
// Discovery requires a PSK — without one there is nothing to authenticate a
// reply with, so the responder simply isn't started.

import {
  sealRecord,
  openRecord,
  DIR_UP,
  DIR_DOWN,
  AAD_DSC_CONTEXT,
  DISCOVERY_MAGIC,
  DISCOVERY_PROBE,
  DISCOVERY_REPLY,
  CHALLENGE_BYTES,
  NONCE_BYTES,
  MAC_BYTES,
  DEFAULT_DISCOVERY_PORT,
} from "@agentbus/protocol";

const MAGIC = new TextEncoder().encode(DISCOVERY_MAGIC);
const PROBE_RECORD_LEN = NONCE_BYTES + CHALLENGE_BYTES + MAC_BYTES; // 48
const PROBE_DATAGRAM_LEN = MAGIC.length + 1 + PROBE_RECORD_LEN; // 53

/** Parse a probe datagram. Returns the 8-byte challenge, or null to ignore. */
export function parseProbe(psk: Uint8Array, datagram: Uint8Array): Uint8Array | null {
  // Exact-length check first: it bounds the sealed plaintext to exactly the
  // challenge size before any crypto runs (onoSendai's buffer-safety pattern).
  if (datagram.length !== PROBE_DATAGRAM_LEN) return null;
  for (let i = 0; i < MAGIC.length; i++) if (datagram[i] !== MAGIC[i]) return null;
  if (datagram[MAGIC.length] !== DISCOVERY_PROBE) return null;
  const record = datagram.subarray(MAGIC.length + 1);
  const plain = openRecord(psk, DIR_UP, 0n, 0n, record, AAD_DSC_CONTEXT);
  if (plain === null || plain.length !== CHALLENGE_BYTES) return null;
  return plain;
}

/** Build the unicast reply: challenge ‖ tcpPort(2 BE), sealed + framed. */
export function buildReply(
  psk: Uint8Array,
  challenge: Uint8Array,
  tcpPort: number,
  nonce?: Uint8Array,
): Uint8Array {
  const plain: Uint8Array = new Uint8Array(CHALLENGE_BYTES + 2);
  plain.set(challenge, 0);
  new DataView(plain.buffer).setUint16(CHALLENGE_BYTES, tcpPort, false);
  const record = sealRecord(psk, DIR_DOWN, 0n, 0n, plain, nonce, AAD_DSC_CONTEXT);
  const out: Uint8Array = new Uint8Array(MAGIC.length + 1 + record.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = DISCOVERY_REPLY;
  out.set(record, MAGIC.length + 1);
  return out;
}

export interface DiscoveryResponder {
  port: number;
  stop(): void;
}

export interface DiscoveryConfig {
  psk: Uint8Array;
  /** The TCP port to advertise (the AgentBus listener). */
  tcpPort: number;
  /** UDP port to listen on (default 41337). */
  discoveryPort?: number;
}

/** Start the UDP responder. Caller must have awaited cryptoReady(). */
export async function startDiscoveryResponder(config: DiscoveryConfig): Promise<DiscoveryResponder> {
  const socket = await Bun.udpSocket({
    port: config.discoveryPort ?? DEFAULT_DISCOVERY_PORT,
    socket: {
      data(sock, buf, port, addr) {
        // A malformed datagram must never take down the responder — one bad
        // packet can't stop the host from being discoverable.
        try {
          const challenge = parseProbe(config.psk, new Uint8Array(buf));
          if (challenge === null) return; // not ours / wrong key / garbage
          sock.send(buildReply(config.psk, challenge, config.tcpPort), port, addr);
        } catch (err) {
          console.error(`discovery: dropped a datagram: ${(err as Error).message}`);
        }
      },
    },
  });
  return {
    port: socket.port,
    stop() {
      socket.close();
    },
  };
}
