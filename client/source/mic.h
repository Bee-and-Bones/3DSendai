// U11 (plan-004) — mic push-to-talk capture. The ring-offset delta math is
// pure C (host-KAT'd by client/test/mic_test.c); all MICU calls live in mic.c,
// which is libctru-only and runtime-unverified without hardware.
//
// Capture is PCM16 @ MICU_SAMPLE_RATE_16360 (~16364 Hz, NOT 16000 — the host
// resamples, U12) into a looped ring; each frame the main loop drains the
// bytes written since the previous read and streams them as AUDIO_CHUNK.
#ifndef SENDAI_MIC_H
#define SENDAI_MIC_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t off;
  uint32_t len;
} ab_mic_span;

// Contiguous spans covering the fresh bytes between `last` (previous read
// position) and `cur` (latest sample offset) in a ring of `size` bytes.
// Returns 0 (nothing new / bad args), 1 (no wrap), or 2 (wrapped). Pure.
static inline int ab_mic_ring_delta(uint32_t last, uint32_t cur, uint32_t size,
                                    ab_mic_span out[2]) {
  if (size == 0 || last >= size || cur >= size || cur == last) return 0;
  if (cur > last) {
    out[0].off = last;
    out[0].len = cur - last;
    return 1;
  }
  out[0].off = last;
  out[0].len = size - last;
  if (cur == 0) return 1;
  out[1].off = 0;
  out[1].len = cur;
  return 2;
}

// --- hardware-only API (mic.c) -----------------------------------------------

// Allocate the 0x1000-aligned capture buffer and bring MICU up. Returns 0 on
// success, <0 when the mic is unavailable — push-to-talk then no-ops (R7).
int ab_mic_init(void);

// Begin looped sampling. Returns 0 on success (init is attempted lazily).
int ab_mic_start(void);

// Stop sampling (keeps MICU initialized for the next hold).
void ab_mic_stop(void);

// Copy the bytes captured since the previous call into `out` (at most `cap`).
// Returns the byte count; 0 when idle or nothing new.
size_t ab_mic_read_fresh(uint8_t *out, size_t cap);

void ab_mic_exit(void);

#endif // SENDAI_MIC_H
