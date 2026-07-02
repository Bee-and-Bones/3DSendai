/* U24 secure-frame KAT: Monocypher must reproduce the golden record bytes in
 * protocol/test/golden/secure-vectors.json (sealed_attach + output_chunk),
 * and reject seq/dir/epoch/context mismatches. Host-compiled, no libctru. */

#include <string.h>
#include "unity.h"
#include "../source/crypto.h"

void setUp(void) {}
void tearDown(void) {}

static const uint64_t EPOCH = 0x1122334455667788ULL;

/* golden vector "sealed_attach": dir=1(up), seq=0, nonce=40..57,
 * plaintext = encodeFrame(ATTACH, 0, {"token":"kat-token"}) */
static const char *ATTACH_PLAIN_HEX =
    "0000001a40000000007b22746f6b656e223a226b61742d746f6b656e227d";
static const char *ATTACH_RECORD_HEX =
    "404142434445464748494a4b4c4d4e4f5051525354555657d439056a90e079168f8fa5cac0f700fcb0808faf722d7eee055a982b2b794148f0f9cc3928249bb2d38f3786b843";

/* golden vector "sealed_output_chunk_seq3": dir=0(down), seq=3, nonce=50..67 */
static const char *CHUNK_PLAIN_HEX = "0000001204000000017b2274657874223a226869227d";
static const char *CHUNK_RECORD_HEX =
    "505152535455565758595a5b5c5d5e5f6061626364656667a80510f86b4797d372464c7f2cf8b3db61f1ac39ab6bd586ae128c454e2343c44c4d86a49472";

static void fill_key(uint8_t key[32]) {
  for (int i = 0; i < 32; i++) key[i] = (uint8_t)i;
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

static void check_vector(const char *plainHex, const char *recordHex, uint8_t dir, uint64_t seq) {
  uint8_t key[32];
  fill_key(key);
  uint8_t plain[128], record[192], built[192];
  size_t plainLen = unhex(plainHex, plain);
  size_t recordLen = unhex(recordHex, record);

  /* seal with the vector's nonce (first 24 bytes of the record) must
   * reproduce the record byte-for-byte */
  size_t builtLen =
      ab_seal_frame(key, AGENTBUS_AAD_MSG_CONTEXT, dir, EPOCH, seq, record, plain, plainLen, built);
  TEST_ASSERT_EQUAL_size_t(recordLen, builtLen);
  TEST_ASSERT_EQUAL_MEMORY(record, built, recordLen);

  /* open must recover the exact plaintext */
  uint8_t opened[128];
  int n = ab_open_frame(key, AGENTBUS_AAD_MSG_CONTEXT, dir, EPOCH, seq, record, recordLen, opened);
  TEST_ASSERT_EQUAL_INT((int)plainLen, n);
  TEST_ASSERT_EQUAL_MEMORY(plain, opened, plainLen);
}

static void test_golden_attach(void) {
  check_vector(ATTACH_PLAIN_HEX, ATTACH_RECORD_HEX, AGENTBUS_DIR_UP, 0);
}

static void test_golden_output_chunk(void) {
  check_vector(CHUNK_PLAIN_HEX, CHUNK_RECORD_HEX, AGENTBUS_DIR_DOWN, 3);
}

static void test_wrong_seq_rejected(void) {
  uint8_t key[32];
  fill_key(key);
  uint8_t record[192], opened[128];
  size_t recordLen = unhex(ATTACH_RECORD_HEX, record);
  TEST_ASSERT_EQUAL_INT(-1, ab_open_frame(key, AGENTBUS_AAD_MSG_CONTEXT, AGENTBUS_DIR_UP, EPOCH, 1,
                                          record, recordLen, opened));
}

static void test_wrong_dir_rejected(void) {
  uint8_t key[32];
  fill_key(key);
  uint8_t record[192], opened[128];
  size_t recordLen = unhex(ATTACH_RECORD_HEX, record);
  TEST_ASSERT_EQUAL_INT(-1, ab_open_frame(key, AGENTBUS_AAD_MSG_CONTEXT, AGENTBUS_DIR_DOWN, EPOCH,
                                          0, record, recordLen, opened));
}

static void test_wrong_epoch_rejected(void) {
  uint8_t key[32];
  fill_key(key);
  uint8_t record[192], opened[128];
  size_t recordLen = unhex(ATTACH_RECORD_HEX, record);
  TEST_ASSERT_EQUAL_INT(-1, ab_open_frame(key, AGENTBUS_AAD_MSG_CONTEXT, AGENTBUS_DIR_UP, EPOCH + 1,
                                          0, record, recordLen, opened));
}

static void test_wrong_context_rejected(void) {
  uint8_t key[32];
  fill_key(key);
  uint8_t record[192], opened[128];
  size_t recordLen = unhex(ATTACH_RECORD_HEX, record);
  TEST_ASSERT_EQUAL_INT(-1, ab_open_frame(key, AGENTBUS_AAD_DSC_CONTEXT, AGENTBUS_DIR_UP, EPOCH, 0,
                                          record, recordLen, opened));
}

static void test_short_frame_rejected(void) {
  uint8_t key[32];
  fill_key(key);
  uint8_t record[AB_FRAME_OVERHEAD - 1] = {0}, opened[16];
  TEST_ASSERT_EQUAL_INT(-1, ab_open_frame(key, AGENTBUS_AAD_MSG_CONTEXT, AGENTBUS_DIR_UP, EPOCH, 0,
                                          record, sizeof record, opened));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_golden_attach);
  RUN_TEST(test_golden_output_chunk);
  RUN_TEST(test_wrong_seq_rejected);
  RUN_TEST(test_wrong_dir_rejected);
  RUN_TEST(test_wrong_epoch_rejected);
  RUN_TEST(test_wrong_context_rejected);
  RUN_TEST(test_short_frame_rejected);
  return UNITY_END();
}
