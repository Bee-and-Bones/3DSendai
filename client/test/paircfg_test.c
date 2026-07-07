/* U7 (plan-004) paircfg KAT: URI parse/serialize round-trip, malformed-URI
 * rejection, and file load/save against a temp path. Pure C, host-compiled.
 * The URI fixture matches host/test/pair.test.ts (shared grammar). */

#include <stdio.h>
#include <string.h>
#include "unity.h"
#include "../source/paircfg.h"

void setUp(void) {}
void tearDown(void) {}

#define PSK64 "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
static const char *FULL_URI = "3dsendai://" PSK64 "@192.168.1.23:4791?token=kat-token";

static void test_parse_full_uri(void) {
  ab_paircfg cfg;
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_parse_uri(FULL_URI, &cfg));
  TEST_ASSERT_EQUAL_STRING(PSK64, cfg.psk_hex);
  TEST_ASSERT_EQUAL_STRING("192.168.1.23", cfg.host);
  TEST_ASSERT_EQUAL_UINT16(4791, cfg.port);
  TEST_ASSERT_EQUAL_STRING("kat-token", cfg.token);
}

static void test_parse_minimal_uri_discovery_only(void) {
  ab_paircfg cfg;
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64, &cfg));
  TEST_ASSERT_EQUAL_STRING(PSK64, cfg.psk_hex);
  TEST_ASSERT_EQUAL_STRING("", cfg.host);
  TEST_ASSERT_EQUAL_UINT16(0, cfg.port);
  TEST_ASSERT_EQUAL_STRING("", cfg.token);
}

static void test_uppercase_psk_normalized(void) {
  ab_paircfg cfg;
  char upper[256];
  snprintf(upper, sizeof upper, "3dsendai://%s", PSK64);
  /* Uppercase only the psk portion — the scheme is case-sensitive. */
  for (char *c = upper + 11; *c; c++)
    if (*c >= 'a' && *c <= 'f') *c = (char)(*c - 'a' + 'A');
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_parse_uri(upper, &cfg));
  TEST_ASSERT_EQUAL_STRING(PSK64, cfg.psk_hex);
}

static void test_serialize_parse_round_trip(void) {
  ab_paircfg cfg, back;
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_parse_uri(FULL_URI, &cfg));
  char uri[256];
  TEST_ASSERT_GREATER_THAN_INT(0, ab_paircfg_to_uri(&cfg, uri, sizeof uri));
  TEST_ASSERT_EQUAL_STRING(FULL_URI, uri);
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_parse_uri(uri, &back));
  TEST_ASSERT_EQUAL_MEMORY(&cfg, &back, sizeof cfg);
}

static void test_malformed_uris_rejected(void) {
  ab_paircfg cfg;
  /* wrong scheme */
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("http://" PSK64, &cfg));
  /* missing / short / non-hex psk */
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://", &cfg));
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://abc123", &cfg));
  TEST_ASSERT_LESS_THAN_INT(0,
      ab_paircfg_parse_uri("3dsendai://gggggggggggggggggggggggggggggggg"
                           "gggggggggggggggggggggggggggggggg", &cfg));
  /* 65 hex chars */
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "0", &cfg));
  /* bad ports */
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "@h:0", &cfg));
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "@h:99999", &cfg));
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "@h:12x", &cfg));
  /* host without port / empty host */
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "@nocolon", &cfg));
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "@:80", &cfg));
  /* empty / malformed query */
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "?token=", &cfg));
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_parse_uri("3dsendai://" PSK64 "?tok=x", &cfg));
  /* rejected parse leaves the struct zeroed (no partial state) */
  TEST_ASSERT_EQUAL_STRING("", cfg.psk_hex);
}

static void test_save_load_round_trip(void) {
  ab_paircfg cfg, back;
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_parse_uri(FULL_URI, &cfg));
  const char *path = "build/paircfg-kat-dir/pair.cfg"; /* exercises mkdir retry */
  remove(path);
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_save(path, &cfg));
  TEST_ASSERT_EQUAL_INT(0, ab_paircfg_load(path, &back));
  TEST_ASSERT_EQUAL_MEMORY(&cfg, &back, sizeof cfg);
}

static void test_absent_file_fails_cleanly(void) {
  ab_paircfg cfg;
  TEST_ASSERT_LESS_THAN_INT(0, ab_paircfg_load("build/definitely-missing/pair.cfg", &cfg));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_full_uri);
  RUN_TEST(test_parse_minimal_uri_discovery_only);
  RUN_TEST(test_uppercase_psk_normalized);
  RUN_TEST(test_serialize_parse_round_trip);
  RUN_TEST(test_malformed_uris_rejected);
  RUN_TEST(test_save_load_round_trip);
  RUN_TEST(test_absent_file_fails_cleanly);
  return UNITY_END();
}
