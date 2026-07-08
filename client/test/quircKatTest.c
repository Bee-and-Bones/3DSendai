/* U6 (plan-004) quirc KAT: the vendored decoder must recover the shared
 * pairing URI byte-exact from a checked-in luma image the U5 TS encoder
 * produced (the cross-library QR gate), and the RGB565->luma conversion must
 * match hand-computed values. Host-compiled, no libctru. */

#include <string.h>
#include "unity.h"
#include "../source/cam.h"
#include "../source/quirc.h"
#include "qrKatFixture.h"

void setUp(void) {}
void tearDown(void) {}

static void test_decode_known_qr_byte_exact(void) {
  struct quirc *q = quirc_new();
  TEST_ASSERT_NOT_NULL(q);
  TEST_ASSERT_EQUAL_INT(0, quirc_resize(q, QR_KAT_WIDTH, QR_KAT_HEIGHT));

  int w = 0, h = 0;
  uint8_t *buf = quirc_begin(q, &w, &h);
  TEST_ASSERT_EQUAL_INT(QR_KAT_WIDTH, w);
  TEST_ASSERT_EQUAL_INT(QR_KAT_HEIGHT, h);
  memcpy(buf, QR_KAT_LUMA, sizeof QR_KAT_LUMA);
  quirc_end(q);

  TEST_ASSERT_EQUAL_INT(1, quirc_count(q));
  struct quirc_code code;
  struct quirc_data data;
  quirc_extract(q, 0, &code);
  TEST_ASSERT_EQUAL_INT(QUIRC_SUCCESS, quirc_decode(&code, &data));
  TEST_ASSERT_EQUAL_INT(QUIRC_DATA_TYPE_BYTE, data.data_type);
  TEST_ASSERT_EQUAL_size_t(strlen(QR_KAT_URI), (size_t)data.payload_len);
  TEST_ASSERT_EQUAL_MEMORY(QR_KAT_URI, data.payload, (size_t)data.payload_len);
  quirc_destroy(q);
}

/* Hand-computed Rec.601 luma for primary/extreme RGB565 values. */
static void test_luma565_hand_values(void) {
  TEST_ASSERT_EQUAL_UINT8(0, ab_cam_luma565(0x0000));   /* black */
  TEST_ASSERT_EQUAL_UINT8(255, ab_cam_luma565(0xFFFF)); /* white */
  TEST_ASSERT_EQUAL_UINT8(76, ab_cam_luma565(0xF800));  /* red:   77*255>>8 */
  TEST_ASSERT_EQUAL_UINT8(149, ab_cam_luma565(0x07E0)); /* green: 150*255>>8 */
  TEST_ASSERT_EQUAL_UINT8(28, ab_cam_luma565(0x001F));  /* blue:  29*255>>8 */
  /* mid gray 0x8410: r8=132 g8=130 b8=132 -> (77*132+150*130+29*132)>>8 = 130 */
  TEST_ASSERT_EQUAL_UINT8(130, ab_cam_luma565(0x8410));
}

static void test_luma_buf_matches_per_pixel(void) {
  const uint16_t px[4] = {0x0000, 0xF800, 0x07E0, 0xFFFF};
  uint8_t out[4];
  ab_cam_luma_buf(px, 4, out);
  for (int i = 0; i < 4; i++) TEST_ASSERT_EQUAL_UINT8(ab_cam_luma565(px[i]), out[i]);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_decode_known_qr_byte_exact);
  RUN_TEST(test_luma565_hand_values);
  RUN_TEST(test_luma_buf_matches_per_pixel);
  return UNITY_END();
}
