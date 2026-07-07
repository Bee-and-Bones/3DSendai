/* U33 terminal-emulator KAT: exercises the pure-C VT/ANSI parser + cell grid +
 * scrollback (client/source/term.c). Host-compiled, no libctru.
 *
 * Test expectation: rendering itself is runtime-unverified on hardware per repo
 * convention; the parser is fully covered here. */

#include <string.h>
#include "unity.h"
#include "../source/term.h"

void setUp(void) {}
void tearDown(void) {}

static ab_term T;

static void feed(const char *s) {
  ab_term_feed(&T, (const uint8_t *)s, strlen(s));
}

/* --- printable + wrap -------------------------------------------------------- */

static void test_printable_fills_left_to_right(void) {
  ab_term_init(&T);
  feed("hello");
  TEST_ASSERT_EQUAL_CHAR('h', ab_term_cell(&T, 0, 0).ch);
  TEST_ASSERT_EQUAL_CHAR('e', ab_term_cell(&T, 0, 1).ch);
  TEST_ASSERT_EQUAL_CHAR('l', ab_term_cell(&T, 0, 2).ch);
  TEST_ASSERT_EQUAL_CHAR('l', ab_term_cell(&T, 0, 3).ch);
  TEST_ASSERT_EQUAL_CHAR('o', ab_term_cell(&T, 0, 4).ch);
  TEST_ASSERT_EQUAL_CHAR(' ', ab_term_cell(&T, 0, 5).ch);
  TEST_ASSERT_EQUAL_INT(5, ab_term_cursor_col(&T));
  TEST_ASSERT_EQUAL_INT(0, ab_term_cursor_row(&T));
}

static void test_wrap_at_last_column(void) {
  ab_term_init(&T);
  /* Fill row 0 exactly (COLS chars), then one more must land on row 1 col 0. */
  char line[AB_TERM_COLS + 2];
  for (int i = 0; i < AB_TERM_COLS; i++) line[i] = 'A';
  line[AB_TERM_COLS] = 'B';
  line[AB_TERM_COLS + 1] = '\0';
  feed(line);
  TEST_ASSERT_EQUAL_CHAR('A', ab_term_cell(&T, 0, AB_TERM_COLS - 1).ch);
  TEST_ASSERT_EQUAL_CHAR('B', ab_term_cell(&T, 1, 0).ch);
  TEST_ASSERT_EQUAL_INT(1, ab_term_cursor_row(&T));
  TEST_ASSERT_EQUAL_INT(1, ab_term_cursor_col(&T));
}

/* --- cursor positioning ------------------------------------------------------ */

static void test_cursor_home(void) {
  ab_term_init(&T);
  feed("abc");
  feed("\x1b[H"); /* home */
  TEST_ASSERT_EQUAL_INT(0, ab_term_cursor_row(&T));
  TEST_ASSERT_EQUAL_INT(0, ab_term_cursor_col(&T));
  feed("Z");
  TEST_ASSERT_EQUAL_CHAR('Z', ab_term_cell(&T, 0, 0).ch);
  TEST_ASSERT_EQUAL_CHAR('b', ab_term_cell(&T, 0, 1).ch); /* unchanged */
}

/* Regression (gcc UB, found by CI): a CUP with missing params must default
 * every position — ESC[H used to leave p[1] uninitialized, landing the cursor
 * on stack garbage (column 49 under gcc). */
static void test_cursor_partial_params_default(void) {
  ab_term_init(&T);
  feed("abcdef");
  feed("\x1b[3H"); /* row only: col must default to 1 (0-based 0) */
  TEST_ASSERT_EQUAL_INT(2, ab_term_cursor_row(&T));
  TEST_ASSERT_EQUAL_INT(0, ab_term_cursor_col(&T));
  feed("\x1b[;7H"); /* col only: row must default to 1 (0-based 0) */
  TEST_ASSERT_EQUAL_INT(0, ab_term_cursor_row(&T));
  TEST_ASSERT_EQUAL_INT(6, ab_term_cursor_col(&T));
}

static void test_cursor_position_rc(void) {
  ab_term_init(&T);
  feed("\x1b[3;5H"); /* row 3, col 5 (1-based) -> row 2, col 4 (0-based) */
  TEST_ASSERT_EQUAL_INT(2, ab_term_cursor_row(&T));
  TEST_ASSERT_EQUAL_INT(4, ab_term_cursor_col(&T));
  feed("X");
  TEST_ASSERT_EQUAL_CHAR('X', ab_term_cell(&T, 2, 4).ch);
}

/* --- erase to line end ------------------------------------------------------- */

static void test_erase_to_line_end(void) {
  ab_term_init(&T);
  feed("hello world");
  feed("\x1b[H");   /* back to col 0 */
  feed("\x1b[5C");  /* forward 5 -> col 5 */
  feed("\x1b[K");   /* erase to end of line */
  TEST_ASSERT_EQUAL_CHAR('h', ab_term_cell(&T, 0, 0).ch);
  TEST_ASSERT_EQUAL_CHAR('o', ab_term_cell(&T, 0, 4).ch);
  TEST_ASSERT_EQUAL_CHAR(' ', ab_term_cell(&T, 0, 5).ch);
  TEST_ASSERT_EQUAL_CHAR(' ', ab_term_cell(&T, 0, 10).ch);
}

/* --- SGR color set / reset --------------------------------------------------- */

static void test_sgr_color_set_and_reset(void) {
  ab_term_init(&T);
  feed("\x1b[31m"); /* red fg */
  feed("R");
  feed("\x1b[0m");  /* reset */
  feed("N");
  ab_cell red = ab_term_cell(&T, 0, 0);
  ab_cell def = ab_term_cell(&T, 0, 1);
  TEST_ASSERT_EQUAL_CHAR('R', red.ch);
  TEST_ASSERT_EQUAL_INT(1, red.attr & AB_ATTR_FG_MASK); /* red index = 31-30 = 1 */
  TEST_ASSERT_EQUAL_CHAR('N', def.ch);
  TEST_ASSERT_EQUAL_UINT16(AB_ATTR_DEFAULT, def.attr);
}

static void test_sgr_bg_and_bold(void) {
  ab_term_init(&T);
  feed("\x1b[1;44mX\x1b[0m");
  ab_cell x = ab_term_cell(&T, 0, 0);
  TEST_ASSERT_TRUE(x.attr & AB_ATTR_BOLD);
  TEST_ASSERT_EQUAL_INT(4, (x.attr & AB_ATTR_BG_MASK) >> AB_ATTR_BG_SHIFT); /* blue bg */
}

/* --- control chars: CR / LF / BS / TAB --------------------------------------- */

static void test_cr_lf(void) {
  ab_term_init(&T);
  feed("abc\r");
  TEST_ASSERT_EQUAL_INT(0, ab_term_cursor_col(&T));
  TEST_ASSERT_EQUAL_INT(0, ab_term_cursor_row(&T));
  feed("\n");
  TEST_ASSERT_EQUAL_INT(1, ab_term_cursor_row(&T));
  feed("d");
  TEST_ASSERT_EQUAL_CHAR('a', ab_term_cell(&T, 0, 0).ch);
  TEST_ASSERT_EQUAL_CHAR('d', ab_term_cell(&T, 1, 0).ch);
}

static void test_backspace(void) {
  ab_term_init(&T);
  feed("abc");
  feed("\b");
  TEST_ASSERT_EQUAL_INT(2, ab_term_cursor_col(&T));
  feed("X"); /* overwrites the 'c' */
  TEST_ASSERT_EQUAL_CHAR('X', ab_term_cell(&T, 0, 2).ch);
}

static void test_tab(void) {
  ab_term_init(&T);
  feed("a\tb");
  TEST_ASSERT_EQUAL_CHAR('a', ab_term_cell(&T, 0, 0).ch);
  TEST_ASSERT_EQUAL_CHAR('b', ab_term_cell(&T, 0, 8).ch); /* tab stop at col 8 */
}

/* --- scrollback -------------------------------------------------------------- */

static void test_scrollback_captures_pushed_lines(void) {
  ab_term_init(&T);
  /* Print ROWS + 5 numbered lines; the first 5 scroll off the live screen. */
  int total = AB_TERM_ROWS + 5;
  for (int i = 0; i < total; i++) {
    char line[8];
    line[0] = (char)('A' + i);
    line[1] = '\0';
    feed(line);
    if (i < total - 1) feed("\r\n");
  }
  /* Live view: top row should be line index 5 ('A'+5). */
  TEST_ASSERT_EQUAL_CHAR((char)('A' + 5), ab_term_cell(&T, 0, 0).ch);
  TEST_ASSERT_EQUAL_INT(5, ab_term_scroll_max(&T));

  /* Scroll up by 5 -> the very first line ('A') is now visible at row 0. */
  ab_term_scroll(&T, 5);
  TEST_ASSERT_EQUAL_INT(5, ab_term_scroll_offset(&T));
  TEST_ASSERT_EQUAL_CHAR('A', ab_term_cell(&T, 0, 0).ch);

  /* Clamp: scrolling further up does not exceed max. */
  ab_term_scroll(&T, 100);
  TEST_ASSERT_EQUAL_INT(5, ab_term_scroll_offset(&T));

  /* Back to bottom. */
  ab_term_scroll_to_bottom(&T);
  TEST_ASSERT_EQUAL_INT(0, ab_term_scroll_offset(&T));
  TEST_ASSERT_EQUAL_CHAR((char)('A' + 5), ab_term_cell(&T, 0, 0).ch);
}

static void test_new_output_pins_to_bottom(void) {
  ab_term_init(&T);
  for (int i = 0; i < AB_TERM_ROWS + 3; i++) feed("x\r\n");
  ab_term_scroll(&T, 3); /* scrolled up */
  TEST_ASSERT_TRUE(ab_term_scroll_offset(&T) > 0);
  feed("y"); /* fresh output snaps back to the live bottom */
  TEST_ASSERT_EQUAL_INT(0, ab_term_scroll_offset(&T));
}

/* --- malformed / partial escapes --------------------------------------------- */

static void test_partial_escape_buffered_across_feeds(void) {
  ab_term_init(&T);
  feed("A");
  ab_term_feed(&T, (const uint8_t *)"\x1b[3", 3); /* incomplete CSI */
  ab_term_feed(&T, (const uint8_t *)"1m", 2);     /* completes: red fg */
  feed("B");
  /* 'A' printed before the escape; 'B' printed red after it. Grid intact. */
  TEST_ASSERT_EQUAL_CHAR('A', ab_term_cell(&T, 0, 0).ch);
  ab_cell b = ab_term_cell(&T, 0, 1);
  TEST_ASSERT_EQUAL_CHAR('B', b.ch);
  TEST_ASSERT_EQUAL_INT(1, b.attr & AB_ATTR_FG_MASK);
}

static void test_malformed_escape_does_not_corrupt(void) {
  ab_term_init(&T);
  feed("ok");
  feed("\x1b[999999999X"); /* absurd param + unsupported final byte */
  feed("Z");
  /* Nothing crashed; 'ok' intact; 'Z' printed after the absorbed sequence. */
  TEST_ASSERT_EQUAL_CHAR('o', ab_term_cell(&T, 0, 0).ch);
  TEST_ASSERT_EQUAL_CHAR('k', ab_term_cell(&T, 0, 1).ch);
  TEST_ASSERT_EQUAL_CHAR('Z', ab_term_cell(&T, 0, 2).ch);
}

static void test_lone_esc_then_text(void) {
  ab_term_init(&T);
  feed("\x1b"); /* ESC with nothing after, in one feed */
  feed("Q");    /* \eQ: unknown 2-byte, absorbed; Q not printed */
  feed("R");    /* back in ground: printed */
  TEST_ASSERT_EQUAL_CHAR('R', ab_term_cell(&T, 0, 0).ch);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_printable_fills_left_to_right);
  RUN_TEST(test_wrap_at_last_column);
  RUN_TEST(test_cursor_home);
  RUN_TEST(test_cursor_partial_params_default);
  RUN_TEST(test_cursor_position_rc);
  RUN_TEST(test_erase_to_line_end);
  RUN_TEST(test_sgr_color_set_and_reset);
  RUN_TEST(test_sgr_bg_and_bold);
  RUN_TEST(test_cr_lf);
  RUN_TEST(test_backspace);
  RUN_TEST(test_tab);
  RUN_TEST(test_scrollback_captures_pushed_lines);
  RUN_TEST(test_new_output_pins_to_bottom);
  RUN_TEST(test_partial_escape_buffered_across_feeds);
  RUN_TEST(test_malformed_escape_does_not_corrupt);
  RUN_TEST(test_lone_esc_then_text);
  return UNITY_END();
}
