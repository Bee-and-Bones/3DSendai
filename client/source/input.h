// U34 — pure control-key -> keystroke byte mapping. NO libctru here so it
// host-compiles for the input_test.c KAT. COMPILES with devkitPro; runtime
// UNVERIFIED without hardware.
#ifndef AG3NT_INPUT_H
#define AG3NT_INPUT_H

#include <stddef.h>
#include <stdint.h>

#include "ui.h" // ab_ui_hit (a plain enum; no libctru)

// Resolve a terminal control-strip key id to the raw bytes to inject into the
// session (hex-encoded on the wire by ab_net_send_keys). Writes up to `cap`
// bytes into `out` and returns the count; returns 0 for keys that carry no wire
// bytes (Ctrl toggle, keyboard, and non-key hits). Mapping (KTD/U34):
//   Esc=1b, Tab=09, Ctrl-C=03, arrows=CSI (up 1b5b41, down 42, right 43, left 44).
size_t ab_input_control_bytes(ab_ui_hit hit, uint8_t *out, size_t cap);

#endif // AG3NT_INPUT_H
