/* U6 (plan 2026-07-20-001) agent-board KAT: upsert/remove, blocked-first stable
 * ordering, identity-tracked cursor across re-sort + removal, cursor-following
 * viewport, blocked-preferring eviction, capacity churn/reuse, exactly-once
 * approval arming, deck predicates, display mapping, and bounded field copies.
 * Pure C (no libctru). */

#include <string.h>
#include "unity.h"
#include "../source/board.h"

void setUp(void) {}
void tearDown(void) {}

/* Convenience: upsert with a status only (idle/blocked/etc.), empty extras. */
static void put(ab_board *b, uint32_t id, const char *status) {
  ab_board_upsert(b, id, "n", "", status, "", "");
}

/* --- upsert: insert then update in place, no duplicate rows ---------------- */
static void test_upsert_inserts_then_updates_in_place(void) {
  ab_board b;
  ab_board_init(&b);
  TEST_ASSERT_EQUAL_INT(0, ab_board_count(&b));
  put(&b, 1, "idle");
  put(&b, 2, "idle");
  TEST_ASSERT_EQUAL_INT(2, ab_board_count(&b));
  /* re-upserting id 1 updates, never duplicates */
  ab_board_upsert(&b, 1, "renamed", "codex", "thinking", "task", "ws");
  TEST_ASSERT_EQUAL_INT(2, ab_board_count(&b));
  const ab_board_row *r = ab_board_find(&b, 1);
  TEST_ASSERT_NOT_NULL(r);
  TEST_ASSERT_EQUAL_STRING("renamed", r->name);
  TEST_ASSERT_EQUAL_STRING("codex", r->kind);
  TEST_ASSERT_EQUAL_STRING("thinking", r->status);
}

/* --- blocked-first ordering, stable within groups ------------------------- */
static void test_blocked_first_stable_within_groups(void) {
  ab_board b;
  ab_board_init(&b);
  put(&b, 1, "idle");
  put(&b, 2, "blocked");
  put(&b, 3, "idle");
  put(&b, 4, "blocked");
  /* blocked (insertion order 2,4) then non-blocked (1,3) */
  TEST_ASSERT_EQUAL_UINT32(2, ab_board_row_at(&b, 0)->session_id);
  TEST_ASSERT_EQUAL_UINT32(4, ab_board_row_at(&b, 1)->session_id);
  TEST_ASSERT_EQUAL_UINT32(1, ab_board_row_at(&b, 2)->session_id);
  TEST_ASSERT_EQUAL_UINT32(3, ab_board_row_at(&b, 3)->session_id);
  TEST_ASSERT_NULL(ab_board_row_at(&b, 4));
  TEST_ASSERT_NULL(ab_board_row_at(&b, -1));
}

static void test_status_change_resorts(void) {
  ab_board b;
  ab_board_init(&b);
  put(&b, 1, "idle");
  put(&b, 2, "idle");
  put(&b, 3, "idle");
  /* 3 -> blocked re-sorts up to the front */
  put(&b, 3, "blocked");
  TEST_ASSERT_EQUAL_UINT32(3, ab_board_row_at(&b, 0)->session_id);
  /* 3 -> working (running_tool) re-sorts back down; insertion order restored */
  put(&b, 3, "running_tool");
  TEST_ASSERT_EQUAL_UINT32(1, ab_board_row_at(&b, 0)->session_id);
  TEST_ASSERT_EQUAL_UINT32(2, ab_board_row_at(&b, 1)->session_id);
  TEST_ASSERT_EQUAL_UINT32(3, ab_board_row_at(&b, 2)->session_id);
}

/* --- cursor identity survives a re-sort (index moves, id doesn't) ---------- */
static void test_cursor_identity_across_resort(void) {
  ab_board b;
  ab_board_init(&b);
  put(&b, 1, "idle");
  put(&b, 2, "idle");
  put(&b, 3, "idle");
  ab_board_cursor_set(&b, 1);
  TEST_ASSERT_EQUAL_INT(0, ab_board_cursor_pos(&b));
  /* 3 -> blocked pushes to front; cursor id 1 slides to pos 1 but stays id 1 */
  put(&b, 3, "blocked");
  TEST_ASSERT_EQUAL_UINT32(1, ab_board_cursor_id(&b));
  TEST_ASSERT_EQUAL_INT(1, ab_board_cursor_pos(&b));
  TEST_ASSERT_EQUAL_UINT32(1, ab_board_cursor_row(&b)->session_id);
}

/* --- nearest-row fallback when the cursor's row disappears ----------------- */
static void test_cursor_nearest_fallback_on_removal(void) {
  ab_board b;
  ab_board_init(&b);
  for (uint32_t i = 1; i <= 5; i++) put(&b, i, "idle");
  /* order = 1,2,3,4,5. cursor on id 3 (pos 2). */
  ab_board_cursor_set(&b, 3);
  TEST_ASSERT_EQUAL_INT(2, ab_board_cursor_pos(&b));
  ab_board_remove(&b, 3);
  /* pos 2 now holds id 4 -> cursor falls there */
  TEST_ASSERT_EQUAL_UINT32(4, ab_board_cursor_id(&b));

  /* cursor on the last row, remove it -> clamps to the new last row */
  ab_board_cursor_set(&b, 5);
  ab_board_remove(&b, 5); /* rows now 1,2,4 */
  TEST_ASSERT_EQUAL_UINT32(4, ab_board_cursor_id(&b));

  /* removing everything drops the cursor to none */
  ab_board_remove(&b, 1);
  ab_board_remove(&b, 2);
  ab_board_remove(&b, 4);
  TEST_ASSERT_EQUAL_INT(0, ab_board_count(&b));
  TEST_ASSERT_EQUAL_UINT32(0, ab_board_cursor_id(&b));
  TEST_ASSERT_EQUAL_INT(-1, ab_board_cursor_pos(&b));
}

/* --- removal compacts the table ------------------------------------------- */
static void test_removal_compacts(void) {
  ab_board b;
  ab_board_init(&b);
  for (uint32_t i = 1; i <= 4; i++) put(&b, i, "idle");
  TEST_ASSERT_EQUAL_INT(0, ab_board_remove(&b, 2));
  TEST_ASSERT_EQUAL_INT(3, ab_board_count(&b));
  TEST_ASSERT_NULL(ab_board_find(&b, 2));
  /* survivors intact and still addressable */
  TEST_ASSERT_NOT_NULL(ab_board_find(&b, 1));
  TEST_ASSERT_NOT_NULL(ab_board_find(&b, 3));
  TEST_ASSERT_NOT_NULL(ab_board_find(&b, 4));
  TEST_ASSERT_EQUAL_INT(-1, ab_board_remove(&b, 99)); /* absent */
}

/* --- viewport follows the cursor and clamps at both ends ------------------- */
static void test_viewport_follow_and_clamp(void) {
  ab_board b;
  ab_board_init(&b);
  for (uint32_t i = 1; i <= 12; i++) put(&b, i, "idle");
  ab_board_cursor_set(&b, 1); /* pos 0 */
  TEST_ASSERT_EQUAL_INT(0, ab_board_viewport_top(&b, 5));
  /* jump the cursor to pos 8 -> window scrolls so pos 8 is the last visible */
  ab_board_cursor_set(&b, 9);
  TEST_ASSERT_EQUAL_INT(4, ab_board_viewport_top(&b, 5)); /* 8 - 5 + 1 */
  /* cursor to the very end -> top clamps at count-visible */
  ab_board_cursor_set(&b, 12);
  TEST_ASSERT_EQUAL_INT(7, ab_board_viewport_top(&b, 5)); /* 12 - 5 */
  /* back to the front -> top clamps at 0 */
  ab_board_cursor_set(&b, 1);
  TEST_ASSERT_EQUAL_INT(0, ab_board_viewport_top(&b, 5));
  /* visible >= count -> everything fits, top 0 */
  TEST_ASSERT_EQUAL_INT(0, ab_board_viewport_top(&b, 20));
}

/* --- cursor_move steps through ordered space, clamped --------------------- */
static void test_cursor_move_clamps(void) {
  ab_board b;
  ab_board_init(&b);
  for (uint32_t i = 1; i <= 3; i++) put(&b, i, "idle");
  ab_board_cursor_set(&b, 1);
  ab_board_cursor_move(&b, -5); /* clamps at front */
  TEST_ASSERT_EQUAL_INT(0, ab_board_cursor_pos(&b));
  ab_board_cursor_move(&b, 99); /* clamps at end */
  TEST_ASSERT_EQUAL_INT(2, ab_board_cursor_pos(&b));
  ab_board_cursor_move(&b, -1);
  TEST_ASSERT_EQUAL_INT(1, ab_board_cursor_pos(&b));
}

/* --- eviction prefers non-blocked; refuses when all blocked --------------- */
static void test_eviction_prefers_non_blocked(void) {
  ab_board b;
  ab_board_init(&b);
  /* fill: id 1 blocked, ids 2..16 idle (16 rows) */
  put(&b, 1, "blocked");
  for (uint32_t i = 2; i <= 16; i++) put(&b, i, "idle");
  TEST_ASSERT_EQUAL_INT(16, ab_board_count(&b));
  /* 17th insert evicts the oldest non-blocked (id 2); blocked id 1 survives */
  TEST_ASSERT_EQUAL_INT(0, ab_board_upsert(&b, 17, "n", "", "idle", "", ""));
  TEST_ASSERT_EQUAL_INT(16, ab_board_count(&b));
  TEST_ASSERT_NOT_NULL(ab_board_find(&b, 1));
  TEST_ASSERT_NULL(ab_board_find(&b, 2));
  TEST_ASSERT_NOT_NULL(ab_board_find(&b, 17));
}

static void test_eviction_refused_when_all_blocked(void) {
  ab_board b;
  ab_board_init(&b);
  for (uint32_t i = 1; i <= 16; i++) put(&b, i, "blocked");
  TEST_ASSERT_EQUAL_INT(16, ab_board_count(&b));
  /* all 16 blocked -> new insert refused, table unchanged */
  int rc = ab_board_upsert(&b, 17, "n", "", "blocked", "", "");
  TEST_ASSERT_LESS_THAN_INT(0, rc);
  TEST_ASSERT_EQUAL_INT(16, ab_board_count(&b));
  TEST_ASSERT_NULL(ab_board_find(&b, 17));
}

/* --- capacity churn: removed slots are reused, never exhausted ------------- */
static void test_slot_churn_reuse(void) {
  ab_board b;
  ab_board_init(&b);
  /* churn far past capacity, removing before each new insert */
  for (uint32_t i = 1; i <= 100; i++) {
    ab_board_upsert(&b, i, "n", "", "idle", "", "");
    if (i > 8) ab_board_remove(&b, i - 8); /* keep ~8 live */
    TEST_ASSERT_TRUE(ab_board_count(&b) <= AB_BOARD_CAP);
  }
  TEST_ASSERT_NOT_NULL(ab_board_find(&b, 100));
  TEST_ASSERT_NULL(ab_board_find(&b, 1));
}

/* --- approval arming is exactly-once under a double fire ------------------- */
static void test_approval_arm_exactly_once(void) {
  ab_board b;
  ab_board_init(&b);
  ab_board_upsert(&b, 1, "claude", "claude", "blocked", "t", "w");
  ab_board_cursor_set(&b, 1);
  uint32_t now = 1000;
  TEST_ASSERT_TRUE(ab_board_approval_enabled(&b, now));
  TEST_ASSERT_TRUE(ab_board_arm_approval(&b, now));  /* first tap sends */
  TEST_ASSERT_FALSE(ab_board_approval_enabled(&b, now));
  TEST_ASSERT_FALSE(ab_board_arm_approval(&b, now)); /* double tap: no second send */

  /* a status update for that row clears the in-flight state */
  ab_board_upsert(&b, 1, "claude", "claude", "blocked", "t", "w");
  TEST_ASSERT_TRUE(ab_board_approval_enabled(&b, now));

  /* re-arm, then let the cooldown elapse instead of a status update */
  TEST_ASSERT_TRUE(ab_board_arm_approval(&b, now));
  TEST_ASSERT_FALSE(ab_board_approval_enabled(&b, now + AB_BOARD_APPROVAL_COOLDOWN - 1));
  TEST_ASSERT_TRUE(ab_board_approval_enabled(&b, now + AB_BOARD_APPROVAL_COOLDOWN));
}

/* --- approval enablement gate: blocked + allowlisted + cursor on the row --- */
static void test_approval_enablement_gate(void) {
  ab_board b;
  ab_board_init(&b);
  ab_board_upsert(&b, 1, "cx", "codex", "blocked", "t", "w");     /* blocked + allowlisted */
  ab_board_upsert(&b, 2, "gm", "gemini", "blocked", "t", "w");    /* blocked, NOT allowlisted */
  ab_board_upsert(&b, 3, "cx", "codex", "running_tool", "t", "w"); /* allowlisted, not blocked */
  uint32_t now = 5;

  ab_board_cursor_set(&b, 1);
  TEST_ASSERT_TRUE(ab_board_approval_enabled(&b, now));
  ab_board_cursor_set(&b, 2);
  TEST_ASSERT_FALSE(ab_board_approval_enabled(&b, now)); /* kind not allowlisted */
  ab_board_cursor_set(&b, 3);
  TEST_ASSERT_FALSE(ab_board_approval_enabled(&b, now)); /* not blocked */
  ab_board_cursor_set(&b, 0);
  TEST_ASSERT_FALSE(ab_board_approval_enabled(&b, now)); /* no cursor row */
}

static void test_kind_allowlist(void) {
  TEST_ASSERT_TRUE(ab_board_kind_allowlisted("codex"));
  TEST_ASSERT_TRUE(ab_board_kind_allowlisted("cursor"));
  TEST_ASSERT_TRUE(ab_board_kind_allowlisted("claude"));
  TEST_ASSERT_TRUE(ab_board_kind_allowlisted("omp"));
  TEST_ASSERT_TRUE(ab_board_kind_allowlisted("opencode"));
  TEST_ASSERT_FALSE(ab_board_kind_allowlisted("gemini"));
  TEST_ASSERT_FALSE(ab_board_kind_allowlisted(""));
  TEST_ASSERT_FALSE(ab_board_kind_allowlisted((const char *)0));
}

/* --- key bank enabled only once a session is focused ---------------------- */
static void test_keybank_enablement(void) {
  TEST_ASSERT_FALSE(ab_board_keybank_enabled(0)); /* nothing focused */
  TEST_ASSERT_TRUE(ab_board_keybank_enabled(7));
}

/* --- status -> short display label ---------------------------------------- */
static void test_status_display_mapping(void) {
  TEST_ASSERT_EQUAL_STRING("working", ab_board_status_label("running_tool"));
  TEST_ASSERT_EQUAL_STRING("BLOCKED", ab_board_status_label("blocked"));
  TEST_ASSERT_EQUAL_STRING("approval?", ab_board_status_label("awaiting_approval"));
  TEST_ASSERT_EQUAL_STRING("thinking", ab_board_status_label("thinking"));
  TEST_ASSERT_EQUAL_STRING("done", ab_board_status_label("done"));
  TEST_ASSERT_EQUAL_STRING("idle", ab_board_status_label("idle"));
  TEST_ASSERT_EQUAL_STRING("failed", ab_board_status_label("failed"));
  TEST_ASSERT_EQUAL_STRING("unknown", ab_board_status_label("unknown"));
  TEST_ASSERT_EQUAL_STRING("unknown", ab_board_status_label("")); /* absent */
  TEST_ASSERT_EQUAL_STRING("unknown", ab_board_status_label("weird_new_state"));
  TEST_ASSERT_EQUAL_STRING("unknown", ab_board_status_label((const char *)0));
}

/* --- Shift+Tab byte sequence is exactly ESC [ Z --------------------------- */
static void test_shift_tab_bytes(void) {
  TEST_ASSERT_EQUAL_INT(3, AB_SHIFT_TAB_LEN);
  TEST_ASSERT_EQUAL_HEX8(0x1B, ab_shift_tab_bytes[0]);
  TEST_ASSERT_EQUAL_HEX8(0x5B, ab_shift_tab_bytes[1]);
  TEST_ASSERT_EQUAL_HEX8(0x5A, ab_shift_tab_bytes[2]);
}

/* --- oversized fields truncate with valid NUL termination ----------------- */
static void test_field_truncation_nul_terminated(void) {
  ab_board b;
  ab_board_init(&b);
  char big[128];
  memset(big, 'x', sizeof big - 1);
  big[sizeof big - 1] = '\0';
  ab_board_upsert(&b, 1, big, big, big, big, big);
  const ab_board_row *r = ab_board_find(&b, 1);
  TEST_ASSERT_NOT_NULL(r);
  TEST_ASSERT_EQUAL_size_t(AB_BOARD_NAME_CAP - 1, strlen(r->name));
  TEST_ASSERT_EQUAL_size_t(AB_BOARD_KIND_CAP - 1, strlen(r->kind));
  TEST_ASSERT_EQUAL_size_t(AB_BOARD_STATUS_CAP - 1, strlen(r->status));
  TEST_ASSERT_EQUAL_size_t(AB_BOARD_TITLE_CAP - 1, strlen(r->title));
  TEST_ASSERT_EQUAL_size_t(AB_BOARD_WORKSPACE_CAP - 1, strlen(r->workspace));
}

/* --- absent optional fields become empty strings; no status -> non-blocked - */
static void test_absent_fields_defaults(void) {
  ab_board b;
  ab_board_init(&b);
  /* NULL extras + NULL status: everything empty, row treated as non-blocked */
  ab_board_upsert(&b, 1, "just-a-name", (const char *)0, (const char *)0, (const char *)0,
                  (const char *)0);
  const ab_board_row *r = ab_board_find(&b, 1);
  TEST_ASSERT_NOT_NULL(r);
  TEST_ASSERT_EQUAL_STRING("just-a-name", r->name);
  TEST_ASSERT_EQUAL_STRING("", r->kind);
  TEST_ASSERT_EQUAL_STRING("", r->status);
  TEST_ASSERT_EQUAL_STRING("", r->title);
  TEST_ASSERT_EQUAL_STRING("", r->workspace);
  /* a blocked row exists; the empty-status row must sort AFTER it (non-blocked) */
  ab_board_upsert(&b, 2, "b", "codex", "blocked", "", "");
  TEST_ASSERT_EQUAL_UINT32(2, ab_board_row_at(&b, 0)->session_id);
  TEST_ASSERT_EQUAL_UINT32(1, ab_board_row_at(&b, 1)->session_id);
  /* missing status is never treated as an approval-eligible blocked row */
  ab_board_cursor_set(&b, 1);
  TEST_ASSERT_FALSE(ab_board_approval_enabled(&b, 0));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_upsert_inserts_then_updates_in_place);
  RUN_TEST(test_blocked_first_stable_within_groups);
  RUN_TEST(test_status_change_resorts);
  RUN_TEST(test_cursor_identity_across_resort);
  RUN_TEST(test_cursor_nearest_fallback_on_removal);
  RUN_TEST(test_removal_compacts);
  RUN_TEST(test_viewport_follow_and_clamp);
  RUN_TEST(test_cursor_move_clamps);
  RUN_TEST(test_eviction_prefers_non_blocked);
  RUN_TEST(test_eviction_refused_when_all_blocked);
  RUN_TEST(test_slot_churn_reuse);
  RUN_TEST(test_approval_arm_exactly_once);
  RUN_TEST(test_approval_enablement_gate);
  RUN_TEST(test_kind_allowlist);
  RUN_TEST(test_keybank_enablement);
  RUN_TEST(test_status_display_mapping);
  RUN_TEST(test_shift_tab_bytes);
  RUN_TEST(test_field_truncation_nul_terminated);
  RUN_TEST(test_absent_fields_defaults);
  return UNITY_END();
}
