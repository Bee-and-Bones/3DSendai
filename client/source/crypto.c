// AgentBus secure transport, client side (U23/U24). See crypto.h.

#include "crypto.h"
#include <string.h>
#include "monocypher.h"

void ab_seal(const uint8_t key[AGENTBUS_KEY_BYTES], const uint8_t nonce[AGENTBUS_NONCE_BYTES],
             const uint8_t *aad, size_t aadLen, const uint8_t *plain, size_t plainLen,
             uint8_t *cipher, uint8_t mac[AGENTBUS_MAC_BYTES]) {
  crypto_aead_lock(cipher, mac, key, nonce, aad, aadLen, plain, plainLen);
}

int ab_open(const uint8_t key[AGENTBUS_KEY_BYTES], const uint8_t nonce[AGENTBUS_NONCE_BYTES],
            const uint8_t *aad, size_t aadLen, const uint8_t *cipher, size_t cipherLen,
            const uint8_t mac[AGENTBUS_MAC_BYTES], uint8_t *plain) {
  return crypto_aead_unlock(plain, mac, key, nonce, aad, aadLen, cipher, cipherLen);
}

static void put_u64_be(uint8_t *out, uint64_t v) {
  for (int i = 0; i < 8; i++) out[i] = (uint8_t)(v >> (56 - 8 * i));
}

void ab_build_aad(const char *context, uint8_t dir, uint64_t epoch, uint64_t seq,
                  uint8_t out[AB_AAD_BYTES]) {
  memcpy(out, context, AB_AAD_CONTEXT_BYTES);
  out[AB_AAD_CONTEXT_BYTES] = dir;
  put_u64_be(out + AB_AAD_CONTEXT_BYTES + 1, epoch);
  put_u64_be(out + AB_AAD_CONTEXT_BYTES + 1 + AGENTBUS_EPOCH_BYTES, seq);
}

size_t ab_seal_frame(const uint8_t key[AGENTBUS_KEY_BYTES], const char *context, uint8_t dir,
                     uint64_t epoch, uint64_t seq, const uint8_t nonce[AGENTBUS_NONCE_BYTES],
                     const uint8_t *plain, size_t plainLen, uint8_t *frame) {
  uint8_t aad[AB_AAD_BYTES];
  ab_build_aad(context, dir, epoch, seq, aad);
  memcpy(frame, nonce, AGENTBUS_NONCE_BYTES);
  ab_seal(key, nonce, aad, sizeof aad, plain, plainLen, frame + AGENTBUS_NONCE_BYTES,
          frame + AGENTBUS_NONCE_BYTES + plainLen);
  return AGENTBUS_NONCE_BYTES + plainLen + AGENTBUS_MAC_BYTES;
}

int ab_open_frame(const uint8_t key[AGENTBUS_KEY_BYTES], const char *context, uint8_t dir,
                  uint64_t epoch, uint64_t seq, const uint8_t *frame, size_t frameLen,
                  uint8_t *plain) {
  if (frameLen < AB_FRAME_OVERHEAD) return -1;
  size_t cipherLen = frameLen - AB_FRAME_OVERHEAD;
  uint8_t aad[AB_AAD_BYTES];
  ab_build_aad(context, dir, epoch, seq, aad);
  const uint8_t *nonce = frame;
  const uint8_t *cipher = frame + AGENTBUS_NONCE_BYTES;
  const uint8_t *mac = frame + AGENTBUS_NONCE_BYTES + cipherLen;
  if (ab_open(key, nonce, aad, sizeof aad, cipher, cipherLen, mac, plain) != 0) return -1;
  return (int)cipherLen;
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int ab_key_from_hex(const char *hex, uint8_t key[AGENTBUS_KEY_BYTES]) {
  size_t n = strlen(hex);
  if (n != (size_t)(AGENTBUS_KEY_BYTES * 2)) return -1;
  for (int i = 0; i < AGENTBUS_KEY_BYTES; i++) {
    int hi = hex_nibble(hex[i * 2]);
    int lo = hex_nibble(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return -1;
    key[i] = (uint8_t)((hi << 4) | lo);
  }
  return 0;
}
