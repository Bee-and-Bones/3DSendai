/* U4 (plan-004) glyph-atlas KAT: the pure tile/Morton index math in
 * termfont.h must match hand-computed values, so a wrong swizzle is caught
 * here — before a hardware run can show garbage glyphs. Host-compiled, no
 * libctru (termfont.h's helpers are pure static-inline C). */

#include <string.h>
#include "unity.h"
#include "../source/termfont.h"

void setUp(void) {}
void tearDown(void) {}

/* Morton offsets hand-computed from the bit interleave x0 y0 x1 y1 x2 y2. */
static void test_morton_matches_hand_table(void) {
  TEST_ASSERT_EQUAL_INT(0, ab_atlas_morton(0, 0));
  TEST_ASSERT_EQUAL_INT(1, ab_atlas_morton(1, 0));
  TEST_ASSERT_EQUAL_INT(2, ab_atlas_morton(0, 1));
  TEST_ASSERT_EQUAL_INT(3, ab_atlas_morton(1, 1));
  TEST_ASSERT_EQUAL_INT(4, ab_atlas_morton(2, 0));
  TEST_ASSERT_EQUAL_INT(8, ab_atlas_morton(0, 2));
  TEST_ASSERT_EQUAL_INT(24, ab_atlas_morton(4, 2));  /* 16 (x2) + 8 (y1) */
  TEST_ASSERT_EQUAL_INT(39, ab_atlas_morton(3, 5));  /* 1+4 (x) + 2+32 (y) */
  TEST_ASSERT_EQUAL_INT(21, ab_atlas_morton(7, 0));  /* 1+4+16 */
  TEST_ASSERT_EQUAL_INT(42, ab_atlas_morton(0, 7));  /* 2+8+32 */
  TEST_ASSERT_EQUAL_INT(63, ab_atlas_morton(7, 7));
}

/* Every intra-tile offset is hit exactly once (the swizzle is a bijection). */
static void test_morton_is_a_bijection(void) {
  int seen[64];
  memset(seen, 0, sizeof seen);
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++) {
      int m = ab_atlas_morton(x, y);
      TEST_ASSERT_TRUE(m >= 0 && m < 64);
      seen[m]++;
    }
  for (int i = 0; i < 64; i++) TEST_ASSERT_EQUAL_INT(1, seen[i]);
}

/* Spread of glyphs: tile coords + byte offsets vs hand-computed values.
 * 16 tiles per 128px row; tile (tx,ty) starts at ((ty*16)+tx)*64 bytes,
 * which collapses to idx*64 for this layout. */
static void test_tile_index_and_offset_hand_values(void) {
  TEST_ASSERT_EQUAL_INT(0, ab_atlas_tile_index(' '));
  TEST_ASSERT_EQUAL_INT(1, ab_atlas_tile_index('!'));
  TEST_ASSERT_EQUAL_INT(33, ab_atlas_tile_index('A')); /* 0x41 - 0x20 */
  TEST_ASSERT_EQUAL_INT(94, ab_atlas_tile_index('~'));

  /* 'A': idx 33 -> tile (1, 2), tile base 33*64 = 2112. */
  TEST_ASSERT_EQUAL_INT(1, ab_atlas_tile_x(33));
  TEST_ASSERT_EQUAL_INT(2, ab_atlas_tile_y(33));
  TEST_ASSERT_EQUAL_INT(2112, ab_atlas_byte_offset(33, 0, 0));
  TEST_ASSERT_EQUAL_INT(2112 + 63, ab_atlas_byte_offset(33, 7, 7));
  TEST_ASSERT_EQUAL_INT(2112 + 39, ab_atlas_byte_offset(33, 3, 5));

  /* '~': idx 94 -> tile (14, 5), base 94*64 = 6016. */
  TEST_ASSERT_EQUAL_INT(14, ab_atlas_tile_x(94));
  TEST_ASSERT_EQUAL_INT(5, ab_atlas_tile_y(94));
  TEST_ASSERT_EQUAL_INT(6016, ab_atlas_byte_offset(94, 0, 0));

  /* Non-printables map nowhere. */
  TEST_ASSERT_EQUAL_INT(-1, ab_atlas_tile_index('\x1f'));
  TEST_ASSERT_EQUAL_INT(-1, ab_atlas_tile_index('\x7f'));
}

/* Every printable ASCII maps to a distinct, in-bounds atlas tile. */
static void test_printables_map_to_distinct_inbounds_tiles(void) {
  int seen[AB_ATLAS_GLYPHS];
  memset(seen, 0, sizeof seen);
  for (int ch = 0x20; ch <= 0x7e; ch++) {
    int idx = ab_atlas_tile_index((char)ch);
    TEST_ASSERT_TRUE(idx >= 0 && idx < AB_ATLAS_GLYPHS);
    /* Whole tile stays inside the A8 texture. */
    TEST_ASSERT_TRUE(ab_atlas_byte_offset(idx, 7, 7) < AB_ATLAS_W * AB_ATLAS_H);
    seen[idx]++;
  }
  for (int i = 0; i < AB_ATLAS_GLYPHS; i++) TEST_ASSERT_EQUAL_INT(1, seen[i]);
}

/* Expanding '!' (rows 18 3C 3C 18 18 00 18 00, bit0 = left) lights exactly the
 * expected Morton positions with 0xFF and leaves the rest 0x00. */
static void test_expand_glyph_bang(void) {
  static const uint8_t bang[8] = {0x18, 0x3C, 0x3C, 0x18, 0x18, 0x00, 0x18, 0x00};
  uint8_t tile[64];
  ab_atlas_expand_glyph(bang, tile);

  int lit = 0;
  for (int i = 0; i < 64; i++) {
    TEST_ASSERT_TRUE(tile[i] == 0x00 || tile[i] == 0xFF);
    if (tile[i] == 0xFF) lit++;
  }
  TEST_ASSERT_EQUAL_INT(16, lit); /* popcount of the rows above */

  /* Row 0 = 0x18: pixels (3,0) and (4,0) lit, (0,0) and (7,0) dark. */
  TEST_ASSERT_EQUAL_UINT8(0xFF, tile[ab_atlas_morton(3, 0)]);
  TEST_ASSERT_EQUAL_UINT8(0xFF, tile[ab_atlas_morton(4, 0)]);
  TEST_ASSERT_EQUAL_UINT8(0x00, tile[ab_atlas_morton(0, 0)]);
  TEST_ASSERT_EQUAL_UINT8(0x00, tile[ab_atlas_morton(7, 0)]);
  /* Row 5 = 0x00: fully dark. */
  for (int x = 0; x < 8; x++) TEST_ASSERT_EQUAL_UINT8(0x00, tile[ab_atlas_morton(x, 5)]);
  /* Row 6 = 0x18 again. */
  TEST_ASSERT_EQUAL_UINT8(0xFF, tile[ab_atlas_morton(3, 6)]);
  TEST_ASSERT_EQUAL_UINT8(0xFF, tile[ab_atlas_morton(4, 6)]);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_morton_matches_hand_table);
  RUN_TEST(test_morton_is_a_bijection);
  RUN_TEST(test_tile_index_and_offset_hand_values);
  RUN_TEST(test_printables_map_to_distinct_inbounds_tiles);
  RUN_TEST(test_expand_glyph_bang);
  return UNITY_END();
}
