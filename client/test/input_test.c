/* U34 input KAT: the pure keystroke byte mapping (input.c) and the hex decode
 * helper (json.c) that TERMINAL_DATA/KEYSTROKE payloads ride on. Host-compiled,
 * no libctru.
 *
 * Test expectation: input wiring (swkbd, touch, physical scroll) is
 * runtime-unverified on hardware per repo convention; the frame-construction
 * helpers are covered here. */

#include <string.h>
#include "unity.h"
#include "../source/input.h"
#include "../source/json.h"

void setUp(void) {}
void tearDown(void) {}

/* --- control-key byte mapping ------------------------------------------------ */

static void expect_bytes(ab_ui_hit hit, const uint8_t *want, size_t wantn) {
  uint8_t out[8];
  size_t n = ab_input_control_bytes(hit, out, sizeof(out));
  TEST_ASSERT_EQUAL_size_t(wantn, n);
  TEST_ASSERT_EQUAL_MEMORY(want, out, wantn);
}

static void test_esc(void) {
  uint8_t want[] = {0x1b};
  expect_bytes(AB_HIT_KEY_ESC, want, 1);
}
static void test_tab(void) {
  uint8_t want[] = {0x09};
  expect_bytes(AB_HIT_KEY_TAB, want, 1);
}
static void test_ctrl_c(void) {
  uint8_t want[] = {0x03};
  expect_bytes(AB_HIT_KEY_CTRLC, want, 1);
}
static void test_arrows_csi(void) {
  uint8_t up[] = {0x1b, 0x5b, 0x41};
  uint8_t down[] = {0x1b, 0x5b, 0x42};
  uint8_t right[] = {0x1b, 0x5b, 0x43};
  uint8_t left[] = {0x1b, 0x5b, 0x44};
  expect_bytes(AB_HIT_KEY_UP, up, 3);
  expect_bytes(AB_HIT_KEY_DOWN, down, 3);
  expect_bytes(AB_HIT_KEY_RIGHT, right, 3);
  expect_bytes(AB_HIT_KEY_LEFT, left, 3);
}
static void test_modifier_and_keyboard_have_no_wire_bytes(void) {
  uint8_t out[8];
  TEST_ASSERT_EQUAL_size_t(0, ab_input_control_bytes(AB_HIT_KEY_CTRL, out, sizeof(out)));
  TEST_ASSERT_EQUAL_size_t(0, ab_input_control_bytes(AB_HIT_KEY_KEYBOARD, out, sizeof(out)));
  TEST_ASSERT_EQUAL_size_t(0, ab_input_control_bytes(AB_HIT_MODE_TOGGLE, out, sizeof(out)));
  TEST_ASSERT_EQUAL_size_t(0, ab_input_control_bytes(AB_HIT_NONE, out, sizeof(out)));
}
static void test_cap_truncates(void) {
  uint8_t out[2];
  /* an arrow is 3 bytes; a cap of 2 must not overrun */
  size_t n = ab_input_control_bytes(AB_HIT_KEY_UP, out, sizeof(out));
  TEST_ASSERT_EQUAL_size_t(2, n);
  TEST_ASSERT_EQUAL_UINT8(0x1b, out[0]);
  TEST_ASSERT_EQUAL_UINT8(0x5b, out[1]);
}

/* --- hex decode -------------------------------------------------------------- */

static void test_hex_decode_roundtrip(void) {
  const char *hex = "1b5b410d03"; /* ESC [ A CR ETX */
  uint8_t out[8];
  size_t n = ab_hex_decode(hex, strlen(hex), out, sizeof(out));
  uint8_t want[] = {0x1b, 0x5b, 0x41, 0x0d, 0x03};
  TEST_ASSERT_EQUAL_size_t(5, n);
  TEST_ASSERT_EQUAL_MEMORY(want, out, 5);
}
static void test_hex_decode_uppercase(void) {
  uint8_t out[4];
  size_t n = ab_hex_decode("FF00A0", 6, out, sizeof(out));
  TEST_ASSERT_EQUAL_size_t(3, n);
  TEST_ASSERT_EQUAL_UINT8(0xFF, out[0]);
  TEST_ASSERT_EQUAL_UINT8(0x00, out[1]);
  TEST_ASSERT_EQUAL_UINT8(0xA0, out[2]);
}
static void test_hex_decode_odd_length_drops_tail(void) {
  uint8_t out[4];
  size_t n = ab_hex_decode("4142f", 5, out, sizeof(out)); /* "AB" + dangling 'f' */
  TEST_ASSERT_EQUAL_size_t(2, n);
  TEST_ASSERT_EQUAL_UINT8('A', out[0]);
  TEST_ASSERT_EQUAL_UINT8('B', out[1]);
}
static void test_hex_decode_stops_at_garbage(void) {
  uint8_t out[8];
  size_t n = ab_hex_decode("4142zz43", 8, out, sizeof(out));
  TEST_ASSERT_EQUAL_size_t(2, n); /* stops at the first non-hex pair */
}
static void test_hex_decode_respects_cap(void) {
  uint8_t out[2];
  size_t n = ab_hex_decode("41424344", 8, out, sizeof(out));
  TEST_ASSERT_EQUAL_size_t(2, n);
}
static void test_hex_decode_empty(void) {
  uint8_t out[4];
  TEST_ASSERT_EQUAL_size_t(0, ab_hex_decode("", 0, out, sizeof(out)));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_esc);
  RUN_TEST(test_tab);
  RUN_TEST(test_ctrl_c);
  RUN_TEST(test_arrows_csi);
  RUN_TEST(test_modifier_and_keyboard_have_no_wire_bytes);
  RUN_TEST(test_cap_truncates);
  RUN_TEST(test_hex_decode_roundtrip);
  RUN_TEST(test_hex_decode_uppercase);
  RUN_TEST(test_hex_decode_odd_length_drops_tail);
  RUN_TEST(test_hex_decode_stops_at_garbage);
  RUN_TEST(test_hex_decode_respects_cap);
  RUN_TEST(test_hex_decode_empty);
  return UNITY_END();
}
