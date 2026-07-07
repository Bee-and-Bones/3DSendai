// U11 (plan-004) — MICU push-to-talk capture. COMPILES with devkitPro;
// runtime UNVERIFIED without hardware. See mic.h for the contract; the
// ring-delta math it uses is pure and host-KAT'd.

#include "mic.h"

#include <malloc.h>
#include <string.h>

#include <3ds.h>

// 32 KiB ring ≈ 1s of PCM16 @16360; the main loop drains ~545 bytes/frame at
// 60fps, so overrun would need ~1s of stalled frames.
#define MIC_BUF_BYTES 0x8000

static u8 *s_buf;
static bool s_init = false;
static bool s_sampling = false;
static u32 s_last = 0;

int ab_mic_init(void) {
  if (s_init) return 0;
  s_buf = (u8 *)memalign(0x1000, MIC_BUF_BYTES);
  if (!s_buf) return -1;
  if (R_FAILED(micInit(s_buf, MIC_BUF_BYTES))) {
    free(s_buf);
    s_buf = NULL;
    return -2; // no mic (or service denied): PTT no-ops (R7)
  }
  // Best-effort: keep the mic usable with the lid closed (matches the
  // aptSetSleepAllowed(false) posture); failure only limits lid-closed use.
  MICU_SetAllowShellClosed(true);
  s_init = true;
  return 0;
}

int ab_mic_start(void) {
  if (!s_init && ab_mic_init() != 0) return -1;
  if (s_sampling) return 0;
  u32 size = micGetSampleDataSize();
  if (size == 0) return -2;
  if (R_FAILED(MICU_StartSampling(MICU_ENCODING_PCM16_SIGNED, MICU_SAMPLE_RATE_16360, 0, size,
                                  true /* loop */)))
    return -3;
  s_last = micGetLastSampleOffset() % size;
  s_sampling = true;
  return 0;
}

void ab_mic_stop(void) {
  if (!s_sampling) return;
  MICU_StopSampling();
  s_sampling = false;
}

size_t ab_mic_read_fresh(uint8_t *out, size_t cap) {
  if (!s_sampling || cap == 0) return 0;
  u32 size = micGetSampleDataSize();
  if (size == 0) return 0;
  u32 cur = micGetLastSampleOffset() % size;
  ab_mic_span spans[2];
  int n = ab_mic_ring_delta(s_last, cur, size, spans);
  size_t copied = 0;
  for (int i = 0; i < n; i++) {
    size_t take = spans[i].len;
    if (copied + take > cap) take = cap - copied;
    memcpy(out + copied, s_buf + spans[i].off, take);
    copied += take;
    if (copied == cap) {
      // Out of room: resume exactly where this read stopped, not at `cur`.
      s_last = (spans[i].off + (u32)take) % size;
      return copied;
    }
  }
  s_last = cur;
  return copied;
}

void ab_mic_exit(void) {
  ab_mic_stop();
  if (s_init) micExit();
  if (s_buf) {
    free(s_buf);
    s_buf = NULL;
  }
  s_init = false;
}
