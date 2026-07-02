// Zero-config UDP discovery, client side (U27) — pure half. See discovery.h.

#include "discovery.h"
#include <string.h>

size_t ab_dsc_build_probe(const uint8_t key[AGENTBUS_KEY_BYTES],
                          const uint8_t challenge[AGENTBUS_CHALLENGE_BYTES],
                          const uint8_t nonce[AGENTBUS_NONCE_BYTES], uint8_t *out) {
  memcpy(out, AGENTBUS_DISCOVERY_MAGIC, AB_DSC_MAGIC_BYTES);
  out[AB_DSC_MAGIC_BYTES] = AGENTBUS_DISCOVERY_PROBE;
  size_t recordLen =
      ab_seal_frame(key, AGENTBUS_AAD_DSC_CONTEXT, AGENTBUS_DIR_UP, 0, 0, nonce, challenge,
                    AGENTBUS_CHALLENGE_BYTES, out + AB_DSC_MAGIC_BYTES + 1);
  return AB_DSC_MAGIC_BYTES + 1 + recordLen;
}

int ab_dsc_parse_reply(const uint8_t key[AGENTBUS_KEY_BYTES],
                       const uint8_t challenge[AGENTBUS_CHALLENGE_BYTES], const uint8_t *datagram,
                       size_t len, uint16_t *out_port) {
  // Exact-length check bounds the decrypted plaintext to challenge+port before
  // any crypto runs (the onoSendai buffer-safety pattern).
  if (len != AB_DSC_REPLY_BYTES) return -1;
  if (memcmp(datagram, AGENTBUS_DISCOVERY_MAGIC, AB_DSC_MAGIC_BYTES) != 0) return -1;
  if (datagram[AB_DSC_MAGIC_BYTES] != AGENTBUS_DISCOVERY_REPLY) return -1;

  uint8_t plain[AGENTBUS_CHALLENGE_BYTES + 2];
  int n = ab_open_frame(key, AGENTBUS_AAD_DSC_CONTEXT, AGENTBUS_DIR_DOWN, 0, 0,
                        datagram + AB_DSC_MAGIC_BYTES + 1, len - AB_DSC_MAGIC_BYTES - 1, plain);
  if (n != (int)sizeof plain) return -1;
  if (memcmp(plain, challenge, AGENTBUS_CHALLENGE_BYTES) != 0) return -1;
  *out_port = (uint16_t)((plain[AGENTBUS_CHALLENGE_BYTES] << 8) | plain[AGENTBUS_CHALLENGE_BYTES + 1]);
  return 0;
}
