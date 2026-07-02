// Attention alerts (U37). See alert.h. COMPILES with devkitPro; runtime
// UNVERIFIED without hardware.
//
// LED: MCUHWC_SetInfoLedPattern drives the hinge notification LED via the MCU,
// which works with the lid closed. Audio: ndsp plays a short square-wave tone;
// ndspInit fails when sdmc:/3ds/dspfirm.cdc is absent, in which case we degrade
// to LED-only (KTD6). aptSetSleepAllowed(false) keeps CPU/DSP/services running
// while the clamshell is shut so both channels fire lid-closed.

#include "alert.h"

#include <3ds.h>
#include <string.h>

#define TONE_RATE 22050
#define TONE_SAMPLES (TONE_RATE / 6) // ~166 ms
#define TONE_FREQ 880                // A5-ish

static bool s_led_ready = false;
static bool s_audio_ready = false;
static int16_t *s_tone = NULL;
static ndspWaveBuf s_wavebuf;

static void build_tone(void) {
  s_tone = (int16_t *)linearAlloc(TONE_SAMPLES * sizeof(int16_t));
  if (!s_tone) {
    s_audio_ready = false;
    return;
  }
  int period = TONE_RATE / TONE_FREQ;
  for (int i = 0; i < TONE_SAMPLES; i++) {
    // square wave with a linear fade-out so it doesn't click.
    int16_t v = ((i / (period / 2)) % 2) ? 9000 : -9000;
    int fade = (TONE_SAMPLES - i) * 100 / TONE_SAMPLES; // 100..0 percent
    s_tone[i] = (int16_t)(v * fade / 100);
  }
  DSP_FlushDataCache(s_tone, TONE_SAMPLES * sizeof(int16_t));

  memset(&s_wavebuf, 0, sizeof(s_wavebuf));
  s_wavebuf.data_pcm16 = s_tone;
  s_wavebuf.nsamples = TONE_SAMPLES;
}

int ab_alert_init(void) {
  aptSetSleepAllowed(false); // survive lid-close (keeps WiFi/DSP/CPU alive)

  s_led_ready = R_SUCCEEDED(mcuHwcInit());

  if (R_SUCCEEDED(ndspInit())) {
    ndspSetOutputMode(NDSP_OUTPUT_MONO);
    ndspChnSetInterp(0, NDSP_INTERP_LINEAR);
    ndspChnSetRate(0, (float)TONE_RATE);
    ndspChnSetFormat(0, NDSP_FORMAT_MONO_PCM16);
    build_tone();
    s_audio_ready = s_tone != NULL;
  } else {
    s_audio_ready = false; // dspfirm.cdc missing -> LED-only (KTD6)
  }
  return 0;
}

ab_alert_class ab_alert_class_from(const char *s) {
  if (!s) return AB_ALERT_ATTENTION;
  if (strcmp(s, "session_ended") == 0) return AB_ALERT_SESSION_ENDED;
  if (strcmp(s, "likely_done") == 0) return AB_ALERT_LIKELY_DONE;
  return AB_ALERT_ATTENTION;
}

static void led_solid(InfoLedPattern *p, u8 r, u8 g, u8 b) {
  memset(p, 0, sizeof(*p));
  p->delay = 0x10;      // 1s between pattern steps
  p->smoothing = 0x20;  // ease in/out
  p->loopDelay = 0xFF;  // play once (no loop)
  p->blinkSpeed = 0x00;
  for (int i = 0; i < 32; i++) {
    p->redPattern[i] = r;
    p->greenPattern[i] = g;
    p->bluePattern[i] = b;
  }
}

void ab_alert_fire(ab_alert_class cls) {
  if (s_led_ready) {
    InfoLedPattern p;
    switch (cls) {
      case AB_ALERT_SESSION_ENDED: led_solid(&p, 0xFF, 0x00, 0x00); break; // red
      case AB_ALERT_LIKELY_DONE:   led_solid(&p, 0x00, 0xFF, 0x00); break; // green
      case AB_ALERT_ATTENTION:
      default:                     led_solid(&p, 0xFF, 0x8C, 0x00); break; // amber
    }
    MCUHWC_SetInfoLedPattern(&p);
  }
  if (s_audio_ready) {
    s_wavebuf.status = NDSP_WBUF_FREE; // allow re-queue
    ndspChnWaveBufAdd(0, &s_wavebuf);
  }
}

void ab_alert_exit(void) {
  if (s_audio_ready) ndspExit();
  if (s_led_ready) mcuHwcExit();
  if (s_tone) {
    linearFree(s_tone);
    s_tone = NULL;
  }
  s_audio_ready = false;
  s_led_ready = false;
}
