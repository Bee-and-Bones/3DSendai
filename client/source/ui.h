// citro2d HUD for the 3DS client. COMPILES; runtime UNVERIFIED without hardware.
// U33+: the top screen renders the focused session's terminal grid (term.c);
// U35 adds the bottom-screen control strip / session picker / macropad toggle.
#ifndef AG3NT_UI_H
#define AG3NT_UI_H

#include <stdbool.h>
#include <stdint.h>

#include "term.h"

#define AB_UI_MAX_SESSIONS 8

// Bottom-screen mode (U35). Terminal control strip vs. the macropad grid.
typedef enum {
  AB_UI_MODE_TERMINAL = 0,
  AB_UI_MODE_MACROPAD = 1
} ab_ui_mode;

// One entry in the session picker, parsed from a SESSION_STATE frame (KTD5:
// one frame per session, no JSON array parser).
typedef struct {
  uint32_t id;
  char name[32];
  bool used;
} ab_ui_session;

typedef struct {
  char status[64];      // e.g. "connected", "reconnecting", "error"
  bool connected;       // network state -> header + bottom hint
  bool config_error;    // fatal config (bad PSK) -> show message, no network

  // Focused session's terminal grid (owned by main.c; NULL until a session
  // exists). The top screen renders this.
  const ab_term *term;
  uint32_t focused_id;  // session id currently focused
  char focused_name[32];

  // Session picker rows (U35).
  ab_ui_session sessions[AB_UI_MAX_SESSIONS];
  int session_count;

  // Bottom-screen mode + sticky Ctrl modifier for the control strip (U35/U34).
  ab_ui_mode mode;
  bool ctrl_sticky;
} ui_state;

void ui_init(void);
void ui_render(const ui_state *st);
void ui_exit(void);

// Bottom-screen hit-test IDs for touch dispatch (U35). Returned by
// ui_hit_bottom for a touch at (tx,ty); AB_HIT_NONE if nothing was hit.
typedef enum {
  AB_HIT_NONE = 0,
  AB_HIT_KEY_CTRL,
  AB_HIT_KEY_ESC,
  AB_HIT_KEY_TAB,
  AB_HIT_KEY_UP,
  AB_HIT_KEY_DOWN,
  AB_HIT_KEY_LEFT,
  AB_HIT_KEY_RIGHT,
  AB_HIT_KEY_CTRLC,
  AB_HIT_KEY_KEYBOARD,
  AB_HIT_MODE_TOGGLE,
  AB_HIT_SESSION_BASE // + row index (0..session_count-1)
} ab_ui_hit;

// Hand-rolled hit-test over the drawn bottom-screen widgets. `st` supplies the
// current mode + session list so the hit map matches what was drawn.
ab_ui_hit ui_hit_bottom(const ui_state *st, int tx, int ty);

#endif // AG3NT_UI_H
