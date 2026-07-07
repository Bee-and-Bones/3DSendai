// U6 (plan-004) — camera QR scanning for pairing. The capture/scan loop
// (cam.c) is libctru-only and runtime-unverified without hardware; this header
// stays pure C (no libctru) so the RGB565->luma conversion host-compiles for
// client/test/quirc_kat_test.c.
#ifndef SENDAI_CAM_H
#define SENDAI_CAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// RGB565 -> 8-bit luma, Rec.601 integer approximation ((77R + 150G + 29B)/256)
// with standard bit-replication channel expansion. Pure; KAT'd against
// hand-computed values.
static inline uint8_t ab_cam_luma565(uint16_t px) {
  uint32_t r = (px >> 11) & 0x1f;
  uint32_t g = (px >> 5) & 0x3f;
  uint32_t b = px & 0x1f;
  uint32_t r8 = (r << 3) | (r >> 2);
  uint32_t g8 = (g << 2) | (g >> 4);
  uint32_t b8 = (b << 3) | (b >> 2);
  return (uint8_t)((77u * r8 + 150u * g8 + 29u * b8) >> 8);
}

/** Convert a run of RGB565 pixels to 8-bit luma. */
static inline void ab_cam_luma_buf(const uint16_t *px, size_t count, uint8_t *out) {
  for (size_t i = 0; i < count; i++) out[i] = ab_cam_luma565(px[i]);
}

// --- hardware-only API (cam.c) -----------------------------------------------

// Start the outer camera + quirc + capture worker thread. Returns 0 on
// success, <0 when the camera/decoder can't initialize — the caller degrades
// to manual config (R7). Safe to call again after ab_cam_stop().
int ab_cam_start(void);

// Stop the worker and tear the camera down. Safe to call when not started.
void ab_cam_stop(void);

// Consume a decoded QR payload if one is ready: copies it (NUL-terminated)
// into `out` and returns true, else false. The worker keeps scanning, so a
// rejected payload is simply re-delivered when the camera sees a QR again.
bool ab_cam_result(char *out, size_t cap);

#endif // SENDAI_CAM_H
