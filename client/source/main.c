// ag3nt 3DS client — main loop for terminal mode (U33-U35). COMPILES with
// devkitPro; runtime UNVERIFIED without hardware.
//
// Connects to the host, streams a tmux pane per session onto the top screen via
// per-session terminal emulators (term.c), and drives the focused session from
// the bottom-screen control strip (touch), the physical buttons (scrollback),
// and the software keyboard. Survives host restarts and 3DS sleep by
// reconnecting automatically.

#include <3ds.h>
#include <stdio.h>
#include <string.h>

#include "config.h"
#include "input.h"
#include "json.h"
#include "net.h"
#include "protocol.h"
#include "term.h"
#include "ui.h"

#define RECONNECT_FRAMES 120 // ~2s at 60fps between reconnect attempts
#define SCROLL_STEP 3        // D-pad rows per press
#define PAGE_STEP AB_TERM_ROWS

// Per-session terminal state. A small fixed table keyed by session_id replaces
// the old flat ui_state.output[1024]; the focused session's grid is what the top
// screen renders (U33). MAX matches the picker capacity.
typedef struct {
  uint32_t id;
  bool used;
  ab_term term;
} session_slot;

static ui_state g_ui;
static session_slot g_sessions[AB_UI_MAX_SESSIONS];
static int g_focused = -1; // index into g_sessions, or -1 when none

static void set_status(const char *s) { snprintf(g_ui.status, sizeof(g_ui.status), "%s", s); }

// Find (or lazily allocate) the terminal slot for a session id. Returns NULL
// when the table is full (drops data for the overflow session — bounded state).
static session_slot *session_for(uint32_t id) {
  for (int i = 0; i < AB_UI_MAX_SESSIONS; i++)
    if (g_sessions[i].used && g_sessions[i].id == id) return &g_sessions[i];
  for (int i = 0; i < AB_UI_MAX_SESSIONS; i++) {
    if (!g_sessions[i].used) {
      g_sessions[i].used = true;
      g_sessions[i].id = id;
      ab_term_init(&g_sessions[i].term);
      return &g_sessions[i];
    }
  }
  return NULL;
}

// Point the UI at a session slot's grid + name and record it as focused.
static void focus_index(int idx) {
  g_focused = idx;
  if (idx < 0) {
    g_ui.term = NULL;
    g_ui.focused_id = 0;
    return;
  }
  g_ui.term = &g_sessions[idx].term;
  g_ui.focused_id = g_sessions[idx].id;
  // Carry the picker name for this id into the header.
  for (int i = 0; i < g_ui.session_count; i++) {
    if (g_ui.sessions[i].used && g_ui.sessions[i].id == g_sessions[idx].id) {
      snprintf(g_ui.focused_name, sizeof(g_ui.focused_name), "%s", g_ui.sessions[i].name);
      break;
    }
  }
}

// Add or update a picker row from a SESSION_STATE frame (KTD5: one per session).
static void upsert_session_row(uint32_t id, const char *name) {
  for (int i = 0; i < g_ui.session_count; i++) {
    if (g_ui.sessions[i].used && g_ui.sessions[i].id == id) {
      if (name && name[0]) snprintf(g_ui.sessions[i].name, sizeof(g_ui.sessions[i].name), "%s", name);
      return;
    }
  }
  if (g_ui.session_count < AB_UI_MAX_SESSIONS) {
    ab_ui_session *s = &g_ui.sessions[g_ui.session_count++];
    s->used = true;
    s->id = id;
    snprintf(s->name, sizeof(s->name), "%s", name && name[0] ? name : "session");
  }
}

static void on_frame(const ab_frame *f, void *ud) {
  (void)ud;
  const char *json = f->payload; // NUL-terminated by ab_net_poll
  switch (f->type) {
    case AGENTBUS_MSG_HELLO:
      g_ui.connected = true;
      set_status("connected");
      break;
    case AGENTBUS_MSG_SESSION_LIST:
      // KTD5: SESSION_LIST is a clear/boundary marker; per-session state arrives
      // as SESSION_STATE frames. Clear the picker so a fresh enumeration replaces
      // stale rows (terminal grids are kept, keyed by id, until reused).
      g_ui.session_count = 0;
      break;
    case AGENTBUS_MSG_SESSION_STATE: {
      char name[32];
      if (!json_get_string(json, "name", name, sizeof(name)))
        json_get_string(json, "agent", name, sizeof(name));
      upsert_session_row(f->session_id, name);
      if (g_focused < 0) { // auto-focus the first session we learn about
        session_slot *sl = session_for(f->session_id);
        if (sl) focus_index((int)(sl - g_sessions));
      } else {
        focus_index(g_focused); // refresh focused_name if it just arrived
      }
      break;
    }
    case AGENTBUS_MSG_TERMINAL_DATA: {
      // {sessionId, hex}: decode the hex pane bytes and feed the session's term.
      // Buffers are static + sized to a full sealed chunk (the host chunks
      // TERMINAL_DATA below the record cap, so hex fits the frame payload). The
      // callback runs on the single main thread, so shared statics are safe.
      static char hex[8192];
      static uint8_t bytes[4096];
      if (json_get_string(json, "hex", hex, sizeof(hex))) {
        session_slot *sl = session_for(f->session_id);
        if (sl) {
          size_t n = ab_hex_decode(hex, strlen(hex), bytes, sizeof(bytes));
          ab_term_feed(&sl->term, bytes, n);
          if (g_focused < 0) focus_index((int)(sl - g_sessions));
        }
      }
      break;
    }
    case AGENTBUS_MSG_ALERT_SIGNAL:
      // Sound + LED are U37; here we only surface the class in the status line.
      set_status("alert");
      break;
    case AGENTBUS_MSG_ERROR: {
      char msg[64];
      if (json_get_string(json, "message", msg, sizeof(msg)))
        set_status(msg);
      else
        set_status("error");
      break;
    }
    default:
      break;
  }
}

// --- U34 input helpers -------------------------------------------------------

// Send raw key bytes to the focused session as a KEYSTROKE frame. No-op when
// nothing is focused. Remote echo only: we never touch the local grid here.
static void send_keys(const uint8_t *bytes, size_t len) {
  if (g_focused < 0) return;
  ab_net_send_keys(g_sessions[g_focused].id, bytes, len);
}

// swkbd: commit text into the focused session as a KEYSTROKE (UTF-8 bytes).
// A pending sticky Ctrl folds the first typed letter into its control code
// (Ctrl + 'c' -> 0x03), matching the control-strip modifier semantics.
static void open_keyboard(void) {
  if (g_focused < 0) return;
  SwkbdState kbd;
  char text[512];
  swkbdInit(&kbd, SWKBD_TYPE_NORMAL, 2, -1);
  swkbdSetHintText(&kbd, "type to the session");
  SwkbdButton btn = swkbdInputText(&kbd, text, sizeof(text));
  if (btn != SWKBD_BUTTON_CONFIRM) return;

  if (g_ui.ctrl_sticky && text[0]) {
    unsigned char c = (unsigned char)text[0];
    if (c >= 'a' && c <= 'z') c -= 'a' - 1;      // ctrl-a..z -> 0x01..0x1a
    else if (c >= 'A' && c <= 'Z') c -= 'A' - 1;
    text[0] = (char)c;
    g_ui.ctrl_sticky = false;
  }
  send_keys((const uint8_t *)text, strlen(text));
}

// Dispatch a control-strip key. Ctrl is a sticky toggle; the keyboard opens
// swkbd; every other key resolves to raw bytes via the pure input mapping.
static void strip_key(ab_ui_hit hit) {
  if (hit == AB_HIT_KEY_CTRL) {
    g_ui.ctrl_sticky = !g_ui.ctrl_sticky; // applied to the next swkbd commit
    return;
  }
  if (hit == AB_HIT_KEY_KEYBOARD) {
    open_keyboard();
    return;
  }
  uint8_t bytes[4];
  size_t n = ab_input_control_bytes(hit, bytes, sizeof(bytes));
  if (n) send_keys(bytes, n);
}

// Physical scrollback navigation on the focused session (sends nothing).
static void scroll_focused(int delta) {
  if (g_focused >= 0) ab_term_scroll(&g_sessions[g_focused].term, delta);
}

// --- U35 touch dispatch ------------------------------------------------------

static void handle_touch(int tx, int ty) {
  ab_ui_hit hit = ui_hit_bottom(&g_ui, tx, ty);
  if (hit == AB_HIT_NONE) return;
  if (hit == AB_HIT_MODE_TOGGLE) {
    g_ui.mode = g_ui.mode == AB_UI_MODE_TERMINAL ? AB_UI_MODE_MACROPAD : AB_UI_MODE_TERMINAL;
    return;
  }
  if (hit >= AB_HIT_SESSION_BASE) {
    int row = hit - AB_HIT_SESSION_BASE;
    if (row < g_ui.session_count && g_ui.sessions[row].used) {
      uint32_t id = g_ui.sessions[row].id;
      char payload[64];
      snprintf(payload, sizeof(payload), "{\"sessionId\":%lu}", (unsigned long)id);
      ab_net_send(AGENTBUS_MSG_FOCUS_SESSION, id, payload);
      session_slot *sl = session_for(id); // ensure a grid exists to repaint into
      if (sl) focus_index((int)(sl - g_sessions));
    }
    return;
  }
  if (hit >= AB_HIT_PAD_BASE) { // a macropad quick-action button (U36)
    int len = 0;
    const uint8_t *keys = ui_pad_keys(hit - AB_HIT_PAD_BASE, &len);
    if (keys && len > 0) send_keys(keys, (size_t)len);
    return;
  }
  strip_key(hit); // a control-strip key
}

static void handle_buttons(u32 down) {
  // Physical buttons scroll the scrollback; they send nothing on the wire.
  if (down & KEY_DUP) scroll_focused(SCROLL_STEP);
  if (down & KEY_DDOWN) scroll_focused(-SCROLL_STEP);
  if (down & KEY_L) scroll_focused(PAGE_STEP);
  if (down & KEY_R) scroll_focused(-PAGE_STEP);
  if (down & KEY_Y) open_keyboard(); // quick keyboard shortcut
}

int main(void) {
  ui_init();
  set_status("starting");

  bool config_error = false;
  if (ab_net_init() != 0) {
    set_status("soc init failed");
    config_error = true;
  } else if (ab_net_set_psk(PAIR_PSK) != 0) {
    // PAIR_PSK is set but malformed. Fail CLOSED: never fall back to plaintext,
    // which would send PAIR_TOKEN in the clear on every retry. Fix config.h.
    set_status("bad PAIR_PSK - fix config.h");
    config_error = true;
  }
  g_ui.config_error = config_error;

  int reconnect_countdown = 0;

  while (aptMainLoop()) {
    hidScanInput();
    u32 down = hidKeysDown();
    if (down & KEY_START) break;

    if (config_error) {
      ui_render(&g_ui); // show the error; do not touch the network
      continue;
    }

    if (!ab_net_connected()) {
      g_ui.connected = false;
      if (reconnect_countdown <= 0) {
        // Zero-config first (U27): one encrypted probe round per reconnect tick;
        // falls back to the compiled-in SERVER_HOST when nothing answers.
        char host[16];
        uint16_t port;
        if (ab_net_discover(DISCOVERY_PORT, host, sizeof host, &port) != 0) {
          snprintf(host, sizeof host, "%s", SERVER_HOST);
          port = SERVER_PORT;
        }
        if (ab_net_connect(host, port) == 0) {
          ab_net_attach(PAIR_TOKEN);
        } else {
          reconnect_countdown = RECONNECT_FRAMES;
        }
      } else {
        reconnect_countdown--;
      }
    } else {
      handle_buttons(down);

      touchPosition touch;
      hidTouchRead(&touch);
      if ((down & KEY_TOUCH) && (touch.px || touch.py)) handle_touch(touch.px, touch.py);

      if (ab_net_poll(on_frame, NULL) < 0) {
        g_ui.connected = false;
        reconnect_countdown = RECONNECT_FRAMES;
      }
    }

    ui_render(&g_ui);
  }

  ab_net_shutdown();
  ui_exit();
  return 0;
}
