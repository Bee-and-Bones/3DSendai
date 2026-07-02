/* U23 cross-library KAT: Monocypher must reproduce libsodium's bytes.
 * Mirrors protocol/test/crypto.test.ts — same key/nonce/aad/plaintext/expected.
 * Host-compiled (no libctru): cc unity.c monocypher.c crypto.c crypto_test.c */

#include <string.h>
#include "unity.h"
#include "../source/crypto.h"

void setUp(void) {}
void tearDown(void) {}

/* key = 00..1f, nonce = 40..57, aad = "ag3nt-kat", pt = "ag3nt KAT v1" */
static const char *KAT_SEALED_HEX =
    "b55e361ea4c03257dbd4f18f7509ce26366ca77ece073cac878f0b36";

static void fill_key(uint8_t key[32]) {
  for (int i = 0; i < 32; i++) key[i] = (uint8_t)i;
}
static void fill_nonce(uint8_t nonce[24]) {
  for (int i = 0; i < 24; i++) nonce[i] = (uint8_t)(0x40 + i);
}
static void hex_of(const uint8_t *bytes, size_t n, char *out) {
  static const char d[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[i * 2] = d[bytes[i] >> 4];
    out[i * 2 + 1] = d[bytes[i] & 0xf];
  }
  out[n * 2] = '\0';
}

static void test_kat_matches_libsodium(void) {
  uint8_t key[32], nonce[24];
  fill_key(key);
  fill_nonce(nonce);
  const uint8_t aad[] = "ag3nt-kat";
  const uint8_t pt[] = "ag3nt KAT v1";
  size_t ptLen = sizeof pt - 1; /* 12 */

  uint8_t cipher[64], mac[16];
  ab_seal(key, nonce, aad, sizeof aad - 1, pt, ptLen, cipher, mac);

  uint8_t sealed[64 + 16];
  memcpy(sealed, cipher, ptLen);
  memcpy(sealed + ptLen, mac, 16);

  char hex[(64 + 16) * 2 + 1];
  hex_of(sealed, ptLen + 16, hex);
  TEST_ASSERT_EQUAL_STRING(KAT_SEALED_HEX, hex);
}

static void test_round_trip(void) {
  uint8_t key[32], nonce[24];
  fill_key(key);
  fill_nonce(nonce);
  const uint8_t aad[] = "ag3nt-kat";
  const uint8_t pt[] = "ag3nt KAT v1";
  size_t ptLen = sizeof pt - 1;

  uint8_t cipher[64], mac[16], plain[64];
  ab_seal(key, nonce, aad, sizeof aad - 1, pt, ptLen, cipher, mac);
  TEST_ASSERT_EQUAL_INT(0, ab_open(key, nonce, aad, sizeof aad - 1, cipher, ptLen, mac, plain));
  TEST_ASSERT_EQUAL_MEMORY(pt, plain, ptLen);
}

static void test_tampered_mac_rejected(void) {
  uint8_t key[32], nonce[24];
  fill_key(key);
  fill_nonce(nonce);
  const uint8_t aad[] = "ag3nt-kat";
  const uint8_t pt[] = "ag3nt KAT v1";
  size_t ptLen = sizeof pt - 1;

  uint8_t cipher[64], mac[16], plain[64];
  ab_seal(key, nonce, aad, sizeof aad - 1, pt, ptLen, cipher, mac);
  mac[15] ^= 0x01;
  TEST_ASSERT_EQUAL_INT(-1, ab_open(key, nonce, aad, sizeof aad - 1, cipher, ptLen, mac, plain));
}

static void test_wrong_key_rejected(void) {
  uint8_t key[32], nonce[24];
  fill_key(key);
  fill_nonce(nonce);
  const uint8_t aad[] = "ag3nt-kat";
  const uint8_t pt[] = "ag3nt KAT v1";
  size_t ptLen = sizeof pt - 1;

  uint8_t cipher[64], mac[16], plain[64];
  ab_seal(key, nonce, aad, sizeof aad - 1, pt, ptLen, cipher, mac);
  key[0] ^= 0xff;
  TEST_ASSERT_EQUAL_INT(-1, ab_open(key, nonce, aad, sizeof aad - 1, cipher, ptLen, mac, plain));
}

static void test_key_from_hex(void) {
  uint8_t key[32];
  TEST_ASSERT_EQUAL_INT(
      0, ab_key_from_hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", key));
  TEST_ASSERT_EQUAL_UINT8(0x00, key[0]);
  TEST_ASSERT_EQUAL_UINT8(0x1f, key[31]);
  TEST_ASSERT_EQUAL_INT(-1, ab_key_from_hex("abc", key));                 /* short */
  TEST_ASSERT_EQUAL_INT(
      -1, ab_key_from_hex("zz0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", key));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_kat_matches_libsodium);
  RUN_TEST(test_round_trip);
  RUN_TEST(test_tampered_mac_rejected);
  RUN_TEST(test_wrong_key_rejected);
  RUN_TEST(test_key_from_hex);
  return UNITY_END();
}
