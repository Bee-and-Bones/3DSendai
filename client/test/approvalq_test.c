/* U9 (plan-004) approval-queue KAT: FIFO order across wrap, full-queue
 * refusal, bounded field copies, responding clears the head. Pure C. */

#include <stdio.h>
#include <string.h>
#include "unity.h"
#include "../source/approval.h"

void setUp(void) {}
void tearDown(void) {}

static void test_fifo_order_and_pop(void) {
  ab_approvalq q;
  ab_approvalq_init(&q);
  TEST_ASSERT_NULL(ab_approvalq_head(&q));
  TEST_ASSERT_TRUE(ab_approvalq_push(&q, 1, "a1", "Bash", "rm -rf build", "high"));
  TEST_ASSERT_TRUE(ab_approvalq_push(&q, 2, "a2", "Edit", "edit x.ts", "low"));
  TEST_ASSERT_EQUAL_INT(2, ab_approvalq_count(&q));

  const ab_approval *h = ab_approvalq_head(&q);
  TEST_ASSERT_EQUAL_STRING("a1", h->id); /* oldest first */
  TEST_ASSERT_EQUAL_UINT32(1, h->session_id);
  TEST_ASSERT_EQUAL_STRING("Bash", h->tool);
  TEST_ASSERT_EQUAL_STRING("rm -rf build", h->detail);
  TEST_ASSERT_EQUAL_STRING("high", h->risk);

  ab_approvalq_pop(&q); /* responded: head clears, next becomes head */
  TEST_ASSERT_EQUAL_STRING("a2", ab_approvalq_head(&q)->id);
  ab_approvalq_pop(&q);
  TEST_ASSERT_NULL(ab_approvalq_head(&q));
  ab_approvalq_pop(&q); /* pop on empty: no crash, still empty */
  TEST_ASSERT_EQUAL_INT(0, ab_approvalq_count(&q));
}

static void test_full_queue_refuses_push(void) {
  ab_approvalq q;
  ab_approvalq_init(&q);
  char id[8];
  for (int i = 0; i < AB_APPROVALQ_CAP; i++) {
    snprintf(id, sizeof id, "a%d", i);
    TEST_ASSERT_TRUE(ab_approvalq_push(&q, (uint32_t)i, id, "t", "d", "low"));
  }
  TEST_ASSERT_FALSE(ab_approvalq_push(&q, 99, "overflow", "t", "d", "low"));
  TEST_ASSERT_EQUAL_INT(AB_APPROVALQ_CAP, ab_approvalq_count(&q));
  TEST_ASSERT_EQUAL_STRING("a0", ab_approvalq_head(&q)->id); /* head untouched */
}

static void test_order_preserved_across_wrap(void) {
  ab_approvalq q;
  ab_approvalq_init(&q);
  ab_approvalq_push(&q, 1, "a", "t", "d", "low");
  ab_approvalq_push(&q, 2, "b", "t", "d", "low");
  ab_approvalq_pop(&q);
  ab_approvalq_push(&q, 3, "c", "t", "d", "low");
  ab_approvalq_push(&q, 4, "d", "t", "d", "low");
  ab_approvalq_push(&q, 5, "e", "t", "d", "low"); /* wraps the array */
  const char *want[] = {"b", "c", "d", "e"};
  for (int i = 0; i < 4; i++) {
    TEST_ASSERT_EQUAL_STRING(want[i], ab_approvalq_head(&q)->id);
    ab_approvalq_pop(&q);
  }
}

static void test_oversized_fields_truncate_safely(void) {
  ab_approvalq q;
  ab_approvalq_init(&q);
  char big[256];
  memset(big, 'x', sizeof big - 1);
  big[sizeof big - 1] = '\0';
  TEST_ASSERT_TRUE(ab_approvalq_push(&q, 1, big, big, big, big));
  const ab_approval *h = ab_approvalq_head(&q);
  TEST_ASSERT_EQUAL_size_t(sizeof h->id - 1, strlen(h->id));
  TEST_ASSERT_EQUAL_size_t(sizeof h->detail - 1, strlen(h->detail));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_fifo_order_and_pop);
  RUN_TEST(test_full_queue_refuses_push);
  RUN_TEST(test_order_preserved_across_wrap);
  RUN_TEST(test_oversized_fields_truncate_safely);
  return UNITY_END();
}
