/* U11 (plan-004) mic ring-delta KAT: contiguous spans across a wraparound,
 * empty/no-op cases, and defensive bad-argument handling. Pure C. */

#include "unity.h"
#include "../source/mic.h"

void setUp(void) {}
void tearDown(void) {}

static void test_no_new_data_and_bad_args(void) {
  ab_mic_span s[2];
  TEST_ASSERT_EQUAL_INT(0, ab_mic_ring_delta(100, 100, 4096, s)); /* nothing new */
  TEST_ASSERT_EQUAL_INT(0, ab_mic_ring_delta(0, 0, 0, s));        /* zero ring */
  TEST_ASSERT_EQUAL_INT(0, ab_mic_ring_delta(4096, 10, 4096, s)); /* last out of range */
  TEST_ASSERT_EQUAL_INT(0, ab_mic_ring_delta(10, 4096, 4096, s)); /* cur out of range */
}

static void test_simple_forward_span(void) {
  ab_mic_span s[2];
  TEST_ASSERT_EQUAL_INT(1, ab_mic_ring_delta(100, 700, 4096, s));
  TEST_ASSERT_EQUAL_UINT32(100, s[0].off);
  TEST_ASSERT_EQUAL_UINT32(600, s[0].len);
}

static void test_wraparound_two_spans(void) {
  ab_mic_span s[2];
  TEST_ASSERT_EQUAL_INT(2, ab_mic_ring_delta(4000, 96, 4096, s));
  TEST_ASSERT_EQUAL_UINT32(4000, s[0].off); /* tail: 4000..4095 */
  TEST_ASSERT_EQUAL_UINT32(96, s[0].len);
  TEST_ASSERT_EQUAL_UINT32(0, s[1].off); /* head: 0..95 */
  TEST_ASSERT_EQUAL_UINT32(96, s[1].len);
  TEST_ASSERT_EQUAL_UINT32(4096 - 4000 + 96, s[0].len + s[1].len);
}

static void test_wrap_landing_exactly_on_zero_is_one_span(void) {
  ab_mic_span s[2];
  TEST_ASSERT_EQUAL_INT(1, ab_mic_ring_delta(4000, 0, 4096, s));
  TEST_ASSERT_EQUAL_UINT32(4000, s[0].off);
  TEST_ASSERT_EQUAL_UINT32(96, s[0].len);
}

static void test_from_zero_full_sweep(void) {
  ab_mic_span s[2];
  TEST_ASSERT_EQUAL_INT(1, ab_mic_ring_delta(0, 4095, 4096, s));
  TEST_ASSERT_EQUAL_UINT32(0, s[0].off);
  TEST_ASSERT_EQUAL_UINT32(4095, s[0].len);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_no_new_data_and_bad_args);
  RUN_TEST(test_simple_forward_span);
  RUN_TEST(test_wraparound_two_spans);
  RUN_TEST(test_wrap_landing_exactly_on_zero_is_one_span);
  RUN_TEST(test_from_zero_full_sweep);
  return UNITY_END();
}
