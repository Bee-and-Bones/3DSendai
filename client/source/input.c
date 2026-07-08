// U34 — pure control-key -> keystroke byte mapping (no libctru). Host-compiles
// for input_test.c. COMPILES with devkitPro; runtime UNVERIFIED without hardware.

#include "input.h"

size_t ab_input_control_bytes(ab_ui_hit hit, uint8_t *out, size_t cap) {
  // 3-byte CSI arrow sequences: ESC '[' <final>.
  static const uint8_t UP[3] = {0x1b, 0x5b, 0x41};
  static const uint8_t DOWN[3] = {0x1b, 0x5b, 0x42};
  static const uint8_t RIGHT[3] = {0x1b, 0x5b, 0x43};
  static const uint8_t LEFT[3] = {0x1b, 0x5b, 0x44};
  const uint8_t *seq = NULL;
  size_t n = 0;
  uint8_t single = 0;

  switch (hit) {
  case AB_HIT_KEY_ESC:
    single = 0x1b;
    n = 1;
    break;
  case AB_HIT_KEY_TAB:
    single = 0x09;
    n = 1;
    break;
  case AB_HIT_KEY_CTRLC:
    single = 0x03;
    n = 1;
    break;
  case AB_HIT_KEY_UP:
    seq = UP;
    n = 3;
    break;
  case AB_HIT_KEY_DOWN:
    seq = DOWN;
    n = 3;
    break;
  case AB_HIT_KEY_RIGHT:
    seq = RIGHT;
    n = 3;
    break;
  case AB_HIT_KEY_LEFT:
    seq = LEFT;
    n = 3;
    break;
  default:
    return 0; // Ctrl toggle / keyboard / non-key: no wire bytes
  }
  if (n > cap) n = cap;
  if (seq) {
    for (size_t i = 0; i < n; i++)
      out[i] = seq[i];
  } else if (n >= 1) {
    out[0] = single;
  }
  return n;
}
