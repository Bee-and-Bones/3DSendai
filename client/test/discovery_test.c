/* U27 discovery KAT: Monocypher must reproduce the golden discovery vectors in
 * protocol/test/golden/secure-vectors.json (probe + reply), and reject wrong
 * key / wrong challenge / bad length / cross-context splices. Host-compiled. */

#include <string.h>
#include "unity.h"
#include "../source/discovery.h"

void setUp(void) {}
void tearDown(void) {}

/* golden "discovery_probe_frame": challenge a0..a7, nonce 40..57 */
static const char *PROBE_RECORD_HEX =
    "404142434445464748494a4b4c4d4e4f50515253545556577498a7d37445dfb13b1e8bf4ed5d306da961c413301d697e";
/* golden "discovery_reply_frame": challenge a0..a7 + port 4791, nonce 50..67 */
static const char *REPLY_RECORD_HEX =
    "505152535455565758595a5b5c5d5e5f606162636465666708a4b249cbe23174618a2ecf2b06f42eda96292bcf0062c35d9b";

static void fill_key(uint8_t key[32]) {
  for (int i = 0; i < 32; i++) key[i] = (uint8_t)i;
}
static void fill_challenge(uint8_t c[8]) {
  for (int i = 0; i < 8; i++) c[i] = (uint8_t)(0xa0 + i);
}
static size_t unhex(const char *hex, uint8_t *out) {
  size_t n = strlen(hex) / 2;
  for (size_t i = 0; i < n; i++) {
    unsigned hi = hex[i * 2], lo = hex[i * 2 + 1];
    hi = hi <= '9' ? hi - '0' : hi - 'a' + 10;
    lo = lo <= '9' ? lo - '0' : lo - 'a' + 10;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return n;
}
static void reply_datagram(uint8_t *out, size_t *outLen) {
  memcpy(out, AGENTBUS_DISCOVERY_MAGIC, 4);
  out[4] = AGENTBUS_DISCOVERY_REPLY;
  *outLen = 5 + unhex(REPLY_RECORD_HEX, out + 5);
}

static void test_build_probe_matches_golden(void) {
  uint8_t key[32], challenge[8], nonce[24];
  fill_key(key);
  fill_challenge(challenge);
  for (int i = 0; i < 24; i++) nonce[i] = (uint8_t)(0x40 + i);

  uint8_t probe[AB_DSC_PROBE_BYTES];
  size_t n = ab_dsc_build_probe(key, challenge, nonce, probe);
  TEST_ASSERT_EQUAL_size_t(AB_DSC_PROBE_BYTES, n);

  TEST_ASSERT_EQUAL_MEMORY("ag3n", probe, 4);
  TEST_ASSERT_EQUAL_UINT8(AGENTBUS_DISCOVERY_PROBE, probe[4]);
  uint8_t expected[64];
  size_t expectedLen = unhex(PROBE_RECORD_HEX, expected);
  TEST_ASSERT_EQUAL_size_t(expectedLen, n - 5);
  TEST_ASSERT_EQUAL_MEMORY(expected, probe + 5, expectedLen);
}

static void test_parse_reply_golden(void) {
  uint8_t key[32], challenge[8], datagram[80];
  size_t len;
  fill_key(key);
  fill_challenge(challenge);
  reply_datagram(datagram, &len);
  TEST_ASSERT_EQUAL_size_t(AB_DSC_REPLY_BYTES, len);

  uint16_t port = 0;
  TEST_ASSERT_EQUAL_INT(0, ab_dsc_parse_reply(key, challenge, datagram, len, &port));
  TEST_ASSERT_EQUAL_UINT16(4791, port);
}

static void test_wrong_key_rejected(void) {
  uint8_t key[32], challenge[8], datagram[80];
  size_t len;
  fill_key(key);
  key[0] ^= 0xff;
  fill_challenge(challenge);
  reply_datagram(datagram, &len);
  uint16_t port;
  TEST_ASSERT_EQUAL_INT(-1, ab_dsc_parse_reply(key, challenge, datagram, len, &port));
}

static void test_wrong_challenge_rejected(void) {
  uint8_t key[32], challenge[8], datagram[80];
  size_t len;
  fill_key(key);
  fill_challenge(challenge);
  challenge[0] ^= 0x01;
  reply_datagram(datagram, &len);
  uint16_t port;
  TEST_ASSERT_EQUAL_INT(-1, ab_dsc_parse_reply(key, challenge, datagram, len, &port));
}

static void test_bad_length_and_type_rejected(void) {
  uint8_t key[32], challenge[8], datagram[80];
  size_t len;
  fill_key(key);
  fill_challenge(challenge);
  reply_datagram(datagram, &len);
  uint16_t port;
  TEST_ASSERT_EQUAL_INT(-1, ab_dsc_parse_reply(key, challenge, datagram, len - 1, &port));
  TEST_ASSERT_EQUAL_INT(-1, ab_dsc_parse_reply(key, challenge, datagram, 0, &port));
  datagram[4] = AGENTBUS_DISCOVERY_PROBE; /* wrong TYPE */
  TEST_ASSERT_EQUAL_INT(-1, ab_dsc_parse_reply(key, challenge, datagram, len, &port));
}

static void test_msg_context_splice_rejected(void) {
  /* A reply-shaped record sealed under the MSG context must not parse. */
  uint8_t key[32], challenge[8], nonce[24];
  fill_key(key);
  fill_challenge(challenge);
  for (int i = 0; i < 24; i++) nonce[i] = (uint8_t)(0x50 + i);

  uint8_t plain[10];
  memcpy(plain, challenge, 8);
  plain[8] = (uint8_t)(4791 >> 8);
  plain[9] = (uint8_t)(4791 & 0xff);

  uint8_t datagram[80];
  memcpy(datagram, AGENTBUS_DISCOVERY_MAGIC, 4);
  datagram[4] = AGENTBUS_DISCOVERY_REPLY;
  size_t recordLen = ab_seal_frame(key, AGENTBUS_AAD_MSG_CONTEXT, AGENTBUS_DIR_DOWN, 0, 0, nonce,
                                   plain, sizeof plain, datagram + 5);
  uint16_t port;
  TEST_ASSERT_EQUAL_INT(-1, ab_dsc_parse_reply(key, challenge, datagram, 5 + recordLen, &port));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_build_probe_matches_golden);
  RUN_TEST(test_parse_reply_golden);
  RUN_TEST(test_wrong_key_rejected);
  RUN_TEST(test_wrong_challenge_rejected);
  RUN_TEST(test_bad_length_and_type_rejected);
  RUN_TEST(test_msg_context_splice_rejected);
  return UNITY_END();
}
