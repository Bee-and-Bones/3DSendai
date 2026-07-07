/* U8 (plan-004) alert-log KAT: ring insert/evict order, per-session mute
 * gating (recorded but suppressed), and newest-first reads. Pure C. */

#include "unity.h"
#include "../source/alert.h"

void setUp(void) {}
void tearDown(void) {}

static void test_push_and_read_newest_first(void) {
  ab_alertlog l;
  ab_alertlog_init(&l);
  TEST_ASSERT_TRUE(ab_alertlog_note(&l, 1, AB_ALERT_ATTENTION, 100));
  TEST_ASSERT_TRUE(ab_alertlog_note(&l, 2, AB_ALERT_LIKELY_DONE, 200));
  TEST_ASSERT_EQUAL_INT(2, l.count);
  const ab_alert_rec *r0 = ab_alertlog_get(&l, 0);
  const ab_alert_rec *r1 = ab_alertlog_get(&l, 1);
  TEST_ASSERT_NOT_NULL(r0);
  TEST_ASSERT_EQUAL_UINT32(2, r0->session_id); /* newest first */
  TEST_ASSERT_EQUAL_UINT32(200, r0->tick);
  TEST_ASSERT_EQUAL_UINT32(1, r1->session_id);
  TEST_ASSERT_NULL(ab_alertlog_get(&l, 2));
  TEST_ASSERT_NULL(ab_alertlog_get(&l, -1));
}

static void test_overflow_evicts_oldest_preserving_order(void) {
  ab_alertlog l;
  ab_alertlog_init(&l);
  for (uint32_t i = 0; i < AB_ALERTLOG_CAP + 3u; i++) {
    ab_alertlog_note(&l, i, AB_ALERT_ATTENTION, i * 10);
  }
  TEST_ASSERT_EQUAL_INT(AB_ALERTLOG_CAP, l.count);
  /* Newest is the last pushed; oldest surviving is (CAP+3-1) - (CAP-1) = 3. */
  TEST_ASSERT_EQUAL_UINT32(AB_ALERTLOG_CAP + 2u, ab_alertlog_get(&l, 0)->session_id);
  TEST_ASSERT_EQUAL_UINT32(3, ab_alertlog_get(&l, AB_ALERTLOG_CAP - 1)->session_id);
  /* Strictly descending session ids = order preserved through the wrap. */
  for (int i = 1; i < AB_ALERTLOG_CAP; i++) {
    TEST_ASSERT_EQUAL_UINT32(ab_alertlog_get(&l, i - 1)->session_id - 1,
                             ab_alertlog_get(&l, i)->session_id);
  }
}

static void test_muted_session_is_logged_but_suppressed(void) {
  ab_alertlog l;
  ab_alertlog_init(&l);
  ab_alertlog_toggle_mute(&l, 5);
  TEST_ASSERT_TRUE(ab_alertlog_is_muted(&l, 5));
  TEST_ASSERT_FALSE(ab_alertlog_note(&l, 5, AB_ALERT_ATTENTION, 1)); /* suppressed */
  TEST_ASSERT_EQUAL_INT(1, l.count);                                 /* still logged */
  TEST_ASSERT_TRUE(ab_alertlog_note(&l, 6, AB_ALERT_ATTENTION, 2));  /* others fire */
  ab_alertlog_toggle_mute(&l, 5);                                    /* unmute */
  TEST_ASSERT_TRUE(ab_alertlog_note(&l, 5, AB_ALERT_ATTENTION, 3));
}

static void test_mute_id_bounds(void) {
  ab_alertlog l;
  ab_alertlog_init(&l);
  ab_alertlog_toggle_mute(&l, AB_ALERTLOG_MAX_MUTE_ID); /* out of range: no-op */
  TEST_ASSERT_FALSE(ab_alertlog_is_muted(&l, AB_ALERTLOG_MAX_MUTE_ID));
  TEST_ASSERT_TRUE(ab_alertlog_note(&l, 1u << 30, AB_ALERT_ATTENTION, 1)); /* huge id fires */
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_push_and_read_newest_first);
  RUN_TEST(test_overflow_evicts_oldest_preserving_order);
  RUN_TEST(test_muted_session_is_logged_but_suppressed);
  RUN_TEST(test_mute_id_bounds);
  return UNITY_END();
}
