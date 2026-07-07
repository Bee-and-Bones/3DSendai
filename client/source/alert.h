// Attention alerts (U37, R38/R39): notification sound + hinge LED, driven by
// ALERT_SIGNAL frames and working with the lid closed. alert.c (the LED/tone
// hardware path) COMPILES with devkitPro; runtime UNVERIFIED without hardware.
// The U8 alert log below is pure C (no libctru), host-KAT'd by
// client/test/alertlog_test.c — same split as termfont.h's atlas helpers.
#ifndef SENDAI_ALERT_H
#define SENDAI_ALERT_H

#include <stdbool.h>
#include <stdint.h>

// Alert classes mirror the host ALERT_SIGNAL payload `class` strings.
typedef enum {
  AB_ALERT_ATTENTION = 0,   // a tmux bell — something wants you
  AB_ALERT_SESSION_ENDED,   // a pane/session died
  AB_ALERT_LIKELY_DONE      // active-then-idle heuristic
} ab_alert_class;

// --- U8 (plan-004): on-screen alert log + per-session mute -------------------

#define AB_ALERTLOG_CAP 16
// Mute is a bitmask keyed by session id; ids at/above this are never muted
// (bounded state — host session ids are small ints starting at 1).
#define AB_ALERTLOG_MAX_MUTE_ID 32

typedef struct {
  uint32_t session_id;
  uint8_t cls;   // ab_alert_class
  uint32_t tick; // coarse time (frame counter at receipt) — no RTC dependency
} ab_alert_rec;

typedef struct {
  ab_alert_rec recs[AB_ALERTLOG_CAP];
  int count; // valid entries (<= CAP)
  int head;  // index of the OLDEST entry once the ring wraps
  uint32_t muted; // bit i set = session id i muted
} ab_alertlog;

static inline void ab_alertlog_init(ab_alertlog *l) {
  l->count = 0;
  l->head = 0;
  l->muted = 0;
}

static inline bool ab_alertlog_is_muted(const ab_alertlog *l, uint32_t sid) {
  return sid < AB_ALERTLOG_MAX_MUTE_ID && (l->muted & (1u << sid)) != 0;
}

static inline void ab_alertlog_toggle_mute(ab_alertlog *l, uint32_t sid) {
  if (sid < AB_ALERTLOG_MAX_MUTE_ID) l->muted ^= 1u << sid;
}

// Record an alert (evicting the oldest when full) and return whether the
// LED/tone should fire: muted sessions are logged but suppressed (R4).
static inline bool ab_alertlog_note(ab_alertlog *l, uint32_t sid, uint8_t cls, uint32_t tick) {
  int slot;
  if (l->count < AB_ALERTLOG_CAP) {
    slot = (l->head + l->count) % AB_ALERTLOG_CAP;
    l->count++;
  } else {
    slot = l->head; // overwrite the oldest
    l->head = (l->head + 1) % AB_ALERTLOG_CAP;
  }
  l->recs[slot].session_id = sid;
  l->recs[slot].cls = cls;
  l->recs[slot].tick = tick;
  return !ab_alertlog_is_muted(l, sid);
}

// Entry i, newest-first (i = 0 is the most recent). NULL when out of range.
static inline const ab_alert_rec *ab_alertlog_get(const ab_alertlog *l, int i) {
  if (i < 0 || i >= l->count) return (const ab_alert_rec *)0;
  int slot = (l->head + l->count - 1 - i) % AB_ALERTLOG_CAP;
  return &l->recs[slot];
}

// Initialize audio (ndsp), the notification LED (mcuHwc), and keep the app alive
// with the lid closed (aptSetSleepAllowed(false)). Safe to call once at startup.
// Audio silently disables itself if the DSP firmware dump is missing; the LED is
// then the only channel (R39). Returns 0 always (best-effort; never fatal).
int ab_alert_init(void);

// Map an ALERT_SIGNAL `class` string to the enum (defaults to ATTENTION).
ab_alert_class ab_alert_class_from(const char *s);

// Raise an alert: light the hinge LED for the class and play a tone if audio is
// available. Works with the lid closed once ab_alert_init ran.
void ab_alert_fire(ab_alert_class cls);

void ab_alert_exit(void);

#endif // SENDAI_ALERT_H
