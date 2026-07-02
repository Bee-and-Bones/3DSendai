// Zero-config UDP discovery, client side (U27, R21) — pure half.
//
// The 3DS broadcasts a probe; a host holding the same PSK replies unicast
// with challenge(8) ‖ tcpPort(2 BE). Datagram layout:
//   MAGIC "ag3n"(4) ‖ TYPE(1) ‖ sealed record (AAD context "ag3nt-dsc-v1",
//   epoch 0, seq 0)
//
// Pure C, no libctru — host-compilable so the KAT runs in CI (the socket half
// lives in net.c). Domain separation from TCP frames comes from the discovery
// AAD context: a captured probe/reply can never splice into a stream.

#ifndef AG3NT_DISCOVERY_H
#define AG3NT_DISCOVERY_H

#include <stddef.h>
#include <stdint.h>
#include "crypto.h"

#define AB_DSC_MAGIC_BYTES 4
// probe record: nonce(24) + challenge(8) + mac(16)
#define AB_DSC_PROBE_BYTES (AB_DSC_MAGIC_BYTES + 1 + AB_FRAME_OVERHEAD + AGENTBUS_CHALLENGE_BYTES)
// reply record: nonce(24) + challenge(8) + port(2) + mac(16)
#define AB_DSC_REPLY_BYTES (AB_DSC_MAGIC_BYTES + 1 + AB_FRAME_OVERHEAD + AGENTBUS_CHALLENGE_BYTES + 2)

// Build a probe datagram into `out` (>= AB_DSC_PROBE_BYTES). Returns its size.
size_t ab_dsc_build_probe(const uint8_t key[AGENTBUS_KEY_BYTES],
                          const uint8_t challenge[AGENTBUS_CHALLENGE_BYTES],
                          const uint8_t nonce[AGENTBUS_NONCE_BYTES], uint8_t *out);

// Parse a reply datagram. Returns 0 and sets *out_port when the reply unlocks
// with the PSK and echoes `challenge`; -1 otherwise (ignore the datagram).
int ab_dsc_parse_reply(const uint8_t key[AGENTBUS_KEY_BYTES],
                       const uint8_t challenge[AGENTBUS_CHALLENGE_BYTES], const uint8_t *datagram,
                       size_t len, uint16_t *out_port);

#endif /* AG3NT_DISCOVERY_H */
