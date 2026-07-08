// AgentBus secure transport, client side (U23/U24).
//
// XChaCha20-Poly1305 AEAD over Monocypher (crypto_aead_lock/unlock). The host
// uses libsodium over the same algorithm; the shared KAT in client/test and
// protocol/test keeps the two byte-identical.
//
// Pure C, no libctru — host-compilable so the KAT runs in CI without devkitPro.
// The RNG (nonce/epoch bytes) lives in net.c (libctru PS service), keeping this
// module deterministic and testable.

#ifndef SENDAI_CRYPTO_H
#define SENDAI_CRYPTO_H

#include <stddef.h>
#include <stdint.h>
#include "protocol.h"

// AAD layout: context(15) | dir(1) | epoch(8 BE) | seq(8 BE) = 32 bytes.
// The context string is 15 bytes ("3dsendai-msg-v1" / "3dsendai-dsc-v1"), no NUL.
#define AB_AAD_CONTEXT_BYTES 15
#define AB_AAD_BYTES (AB_AAD_CONTEXT_BYTES + 1 + AGENTBUS_EPOCH_BYTES + AGENTBUS_SEQ_BYTES)

// A sealed frame is nonce(24) | ciphertext(plainLen) | mac(16).
#define AB_FRAME_OVERHEAD (AGENTBUS_NONCE_BYTES + AGENTBUS_MAC_BYTES)

// Low-level AEAD. `cipher` may alias `plain` (Monocypher supports in-place).
void ab_seal(const uint8_t key[AGENTBUS_KEY_BYTES], const uint8_t nonce[AGENTBUS_NONCE_BYTES],
             const uint8_t *aad, size_t aadLen, const uint8_t *plain, size_t plainLen,
             uint8_t *cipher, uint8_t mac[AGENTBUS_MAC_BYTES]);

// Returns 0 on success, -1 on authentication failure.
int ab_open(const uint8_t key[AGENTBUS_KEY_BYTES], const uint8_t nonce[AGENTBUS_NONCE_BYTES],
            const uint8_t *aad, size_t aadLen, const uint8_t *cipher, size_t cipherLen,
            const uint8_t mac[AGENTBUS_MAC_BYTES], uint8_t *plain);

// Build the 32-byte AAD. `context` must be AB_AAD_CONTEXT_BYTES long.
void ab_build_aad(const char *context, uint8_t dir, uint64_t epoch, uint64_t seq,
                  uint8_t out[AB_AAD_BYTES]);

// Seal one frame: writes nonce|ct|mac contiguously into `frame`. Returns the
// total byte length (AGENTBUS_NONCE_BYTES + plainLen + AGENTBUS_MAC_BYTES).
size_t ab_seal_frame(const uint8_t key[AGENTBUS_KEY_BYTES], const char *context, uint8_t dir,
                     uint64_t epoch, uint64_t seq, const uint8_t nonce[AGENTBUS_NONCE_BYTES],
                     const uint8_t *plain, size_t plainLen, uint8_t *frame);

// Open one frame (nonce|ct|mac). Returns plaintext length or -1 on failure.
// `frameLen` must be at least AB_FRAME_OVERHEAD; `plain` needs frameLen-40 bytes.
int ab_open_frame(const uint8_t key[AGENTBUS_KEY_BYTES], const char *context, uint8_t dir,
                  uint64_t epoch, uint64_t seq, const uint8_t *frame, size_t frameLen,
                  uint8_t *plain);

// Hex <-> 32-byte key. ab_key_from_hex returns 0 on success, -1 on bad input.
int ab_key_from_hex(const char *hex, uint8_t key[AGENTBUS_KEY_BYTES]);

#endif /* SENDAI_CRYPTO_H */
