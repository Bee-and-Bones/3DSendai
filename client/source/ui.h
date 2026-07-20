// citro2d HUD for the 3DS client. COMPILES; runtime UNVERIFIED without hardware.
// U33+: the top screen renders the focused session's terminal grid (term.c);
// U35 adds the bottom-screen control strip / session picker / macropad toggle.
// U7 (plan-001) adds the coupled board/terminal screen axis: the agent board
// (top: the ab_board list; bottom: the board deck) is the attach-time landing,
// one A/B toggle away from the terminal grid; the two screens are never mixed.
#ifndef SENDAI_UI_H
#define SENDAI_UI_H

#include <stdbool.h>
#include <stdint.h>

#include "alert.h"
#include "approval.h"
#include "board.h"
#include "term.h"

#define AB_UI_MAX_SESSIONS 8

// U7: board rows visible in the top-screen viewport at once (~240px / row
// height). Single-sourced so main.c (viewport clamp) and ui.c (row draw) agree.
#define AB_UI_BOARD_VISIBLE 9

// U7 (plan-001): the coupled top-level screen axis. BOARD (top: agent board;
// bottom: board deck) is the unconditional attach-time default — enum value 0
// is the zero-initialized landing state; TERMINAL (top: grid; bottom: the
// ab_ui_mode cycle below) is entered by activating a board row (A) and left by
// the Back button (B). One toggle switches both screens together — never mixed.
typedef enum { AB_UI_SCREEN_BOARD = 0, AB_UI_SCREEN_TERMINAL = 1 } ab_ui_screen;

// Bottom-screen mode WITHIN the terminal screen (U35; U8 adds the alert log).
// Y / the toggle cycles them. Ignored in board mode (the deck is fixed).
typedef enum { AB_UI_MODE_TERMINAL = 0, AB_UI_MODE_MACROPAD = 1, AB_UI_MODE_ALERTS = 2 } ab_ui_mode;

// One entry in the session picker, parsed from a SESSION_STATE frame (KTD5:
// one frame per session, no JSON array parser).
typedef struct {
  uint32_t id;
  char name[32];
  bool used;
} ab_ui_session;

typedef struct {
  char status[64];   // e.g. "connected", "reconnecting", "error"
  bool connected;    // network state -> header + bottom hint
  bool config_error; // fatal config (bad PSK) -> show message, no network

  // Focused session's terminal grid (owned by main.c; NULL until a session
  // exists). The top screen renders this.
  const ab_term *term;
  uint32_t focused_id; // session id currently focused
  char focused_name[32];

  // Session picker rows (U35).
  ab_ui_session sessions[AB_UI_MAX_SESSIONS];
  int session_count;

  // Bottom-screen mode + sticky Ctrl modifier for the control strip (U35/U34).
  ab_ui_mode mode;
  bool ctrl_sticky;

  // U8: the alert log (owned by main.c) + the current coarse tick, so the
  // list view can show approximate ages without an RTC.
  const ab_alertlog *alerts;
  uint32_t tick;

  // U9: pending approvals (owned by main.c). While non-empty the top screen
  // shows the head as an overlay and A/B answer it instead of Enter/Esc.
  const ab_approvalq *approvals;

  // U7 (plan-001): the coupled screen axis + the agent board it renders.
  ab_ui_screen screen;   // BOARD (attach landing) vs TERMINAL — never mixed
  const ab_board *board; // agent board model (owned by main.c; NULL-safe)
  int board_top;         // first ordered board row to draw (viewport top,
                         // clamped by main.c via ab_board_viewport_top each frame)
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
  AB_HIT_BOARD_ACCEPT,       // U7: board deck — arm+send MACRO_INTENT approve (cursor row)
  AB_HIT_BOARD_DENY,         // U7: board deck — arm+send MACRO_INTENT reject (cursor row)
  AB_HIT_PAD_BASE = 100,     // + macropad button index (0..ui_pad_count()-1)
  AB_HIT_SESSION_BASE = 200, // + picker row index (0..session_count-1)
  AB_HIT_ALERT_BASE = 300,   // + alert-log row index (U8: tap toggles mute)
  AB_HIT_DECK_BASE = 400     // U7: + board-deck key-bank index (0..ui_deck_count()-1)
} ab_ui_hit;

// Hand-rolled hit-test over the drawn bottom-screen widgets. `st` supplies the
// current mode + session list so the hit map matches what was drawn.
ab_ui_hit ui_hit_bottom(const ui_state *st, int tx, int ty);

// Macropad (U36): a compiled-in default set of terminal quick-action buttons.
// Configurable by editing the table in ui.c (the device's build-time-config
// idiom, R36); the host `keymap.ts` + `layouts/terminal.pad` mirror the intent
// vocabulary for the future host-pushed-layout path. Returns the raw key bytes
// a button sends (fed straight into a KEYSTROKE frame), or NULL if out of range.
int ui_pad_count(void);
const uint8_t *ui_pad_keys(int index, int *out_len);

// Board deck key bank (U7): arrows / Enter / Esc / Tab / Shift+Tab / Space,
// sent as raw bytes to the FOCUSED session through the KEYSTROKE path (mirrors
// the macropad accessors). Shift+Tab returns the KAT-pinned ab_shift_tab_bytes.
// Returns the raw bytes for a deck button, or NULL if out of range.
int ui_deck_count(void);
const uint8_t *ui_deck_keys(int index, int *out_len);

#endif // SENDAI_UI_H
