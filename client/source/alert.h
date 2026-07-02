// Attention alerts (U37, R38/R39): notification sound + hinge LED, driven by
// ALERT_SIGNAL frames and working with the lid closed. COMPILES with devkitPro;
// runtime UNVERIFIED without hardware.
#ifndef AG3NT_ALERT_H
#define AG3NT_ALERT_H

// Alert classes mirror the host ALERT_SIGNAL payload `class` strings.
typedef enum {
  AB_ALERT_ATTENTION = 0,   // a tmux bell — something wants you
  AB_ALERT_SESSION_ENDED,   // a pane/session died
  AB_ALERT_LIKELY_DONE      // active-then-idle heuristic
} ab_alert_class;

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

#endif // AG3NT_ALERT_H
