// 3dsendai 3DS client — main loop for terminal mode (U33-U35). COMPILES with
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

#include "alert.h"
#include "cam.h"
#include "config.h"
#include "input.h"
#include "json.h"
#include "net.h"
#include "paircfg.h"
#include "protocol.h"
#include "term.h"
#include "ui.h"

#define RECONNECT_FRAMES 120 // ~2s at 60fps between reconnect attempts
#define HELD_SCROLL_STEP 2   // rows/frame while a scroll control is held
#define PAGE_STEP AB_TERM_ROWS
#define CPAD_DEADZONE 24     // circle-pad neutral zone (raw dy ~ +/-156 range)

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

// U7: the effective pairing config — loaded from SD at boot, falling back to
// the compile-time config.h values; replaced live by a successful QR scan.
static ab_paircfg g_cfg;
static bool g_scanning = false; // U6 scan screen active

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
      // Fresh attach/reconnect: clear the picker so the enumeration that follows
      // (per-session SESSION_STATE frames) repopulates it cleanly. Clearing here
      // rather than on SESSION_LIST is order-independent — the host emits the
      // SESSION_LIST boundary AFTER the states, so clearing on it wiped the list
      // (the "waiting for sessions..." bug).
      g_ui.session_count = 0;
      // U3 (plan-004): report the device grid so the host sizes the tmux client
      // to it (wrap once, at device width). On every HELLO, so a reconnect or
      // host restart re-sizes.
      {
        char size_payload[48];
        snprintf(size_payload, sizeof(size_payload), "{\"cols\":%d,\"rows\":%d}", AB_TERM_COLS,
                 AB_TERM_ROWS);
        ab_net_send(AGENTBUS_MSG_CLIENT_SIZE, 0, size_payload);
      }
      break;
    case AGENTBUS_MSG_SESSION_LIST:
      // Boundary marker only (KTD5); the picker is populated by SESSION_STATE and
      // cleared on HELLO. No-op here.
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
    case AGENTBUS_MSG_ALERT_SIGNAL: {
      // {sessionId, class}: raise the hinge LED + a tone (lid-closed capable).
      char cls[24];
      ab_alert_class ac =
          json_get_string(json, "class", cls, sizeof(cls)) ? ab_alert_class_from(cls) : AB_ALERT_ATTENTION;
      ab_alert_fire(ac);
      set_status("alert");
      break;
    }
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

// Focus a session by id: tell the host, and point the UI at its grid. Shared by
// the touch picker and the SELECT session-cycle button.
static void focus_session_id(uint32_t id) {
  char payload[64];
  snprintf(payload, sizeof(payload), "{\"sessionId\":%lu}", (unsigned long)id);
  ab_net_send(AGENTBUS_MSG_FOCUS_SESSION, id, payload);
  session_slot *sl = session_for(id); // ensure a grid exists to repaint into
  if (sl) focus_index((int)(sl - g_sessions));
}

// Cycle focus to the next session in the picker (SELECT). No-op with <2 sessions.
static void cycle_session(void) {
  if (g_ui.session_count < 2) return;
  int cur = -1;
  for (int i = 0; i < g_ui.session_count; i++)
    if (g_ui.sessions[i].used && g_ui.sessions[i].id == g_ui.focused_id) { cur = i; break; }
  for (int step = 1; step <= g_ui.session_count; step++) {
    int i = (cur + step) % g_ui.session_count;
    if (g_ui.sessions[i].used) { focus_session_id(g_ui.sessions[i].id); return; }
  }
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
    if (row < g_ui.session_count && g_ui.sessions[row].used) focus_session_id(g_ui.sessions[row].id);
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

// Physical button map (terminal + macropad modes):
//   A = Enter    B = Esc    X = keyboard    Y = toggle Terminal/Macropad
//   SELECT = next session   START = quit (handled in main)
//   D-pad up/down + Circle pad = scroll scrollback (continuous while held)
//   L / R = page up / down
// `down` = edge (this frame), `held` = level (still held). Scroll uses held so
// holding the pad scrolls continuously; actions use down so they fire once.
static const uint8_t KEY_ENTER_BYTES[1] = {0x0d};
static const uint8_t KEY_ESC_BYTES[1] = {0x1b};

static void handle_buttons(u32 down, u32 held) {
  // --- continuous scroll (held) ---
  if (held & KEY_DUP) scroll_focused(HELD_SCROLL_STEP);
  if (held & KEY_DDOWN) scroll_focused(-HELD_SCROLL_STEP);
  // Circle pad: proportional scroll; up (dy>0) pans into history.
  circlePosition cp;
  hidCircleRead(&cp);
  if (cp.dy > CPAD_DEADZONE) scroll_focused(1 + cp.dy / 48);
  else if (cp.dy < -CPAD_DEADZONE) scroll_focused(-(1 + (-cp.dy) / 48));

  // --- edge actions (down) ---
  if (down & KEY_L) scroll_focused(PAGE_STEP);
  if (down & KEY_R) scroll_focused(-PAGE_STEP);
  if (down & KEY_A) send_keys(KEY_ENTER_BYTES, 1);
  if (down & KEY_B) send_keys(KEY_ESC_BYTES, 1);
  if (down & KEY_X) open_keyboard();
  if (down & KEY_Y) g_ui.mode = g_ui.mode == AB_UI_MODE_TERMINAL ? AB_UI_MODE_MACROPAD : AB_UI_MODE_TERMINAL;
  if (down & KEY_SELECT) cycle_session();
}

// U6/U7 scan screen: X starts the camera while offline, B cancels; a decoded
// 3dsendai:// URI is persisted to SD (pair.cfg) and applied live — no
// config.h edit, no rebuild. Returns true when a new pairing was applied.
static bool handle_scan(u32 down) {
  if (!g_scanning) {
    if (down & KEY_X) {
      if (ab_cam_start() == 0) {
        g_scanning = true;
        set_status("point camera at host QR (B cancels)");
      } else {
        // R7: camera init failed — degrade to the manual config.h path.
        set_status("camera unavailable - pair via config.h");
      }
    }
    return false;
  }
  if (down & KEY_B) {
    ab_cam_stop();
    g_scanning = false;
    set_status("scan cancelled");
    return false;
  }
  char uri[256];
  if (!ab_cam_result(uri, sizeof uri)) return false;
  ab_paircfg cfg;
  if (ab_paircfg_parse_uri(uri, &cfg) != 0) {
    set_status("not a 3dsendai pairing QR - still scanning");
    return false;
  }
  ab_cam_stop();
  g_scanning = false;
  // Persist first; a save failure still pairs for this boot (degraded, said so).
  if (ab_paircfg_save(AB_PAIRCFG_PATH, &cfg) == 0) set_status("paired - connecting");
  else set_status("paired (SD save failed - not persisted)");
  g_cfg = cfg;
  return true;
}

int main(void) {
  ui_init();
  ab_alert_init(); // audio + hinge LED + keep-alive through lid-close (U37)
  set_status("starting");

  // U7: SD-persisted pairing supersedes config.h; config.h stays as the
  // dev/build-time fallback when no pair.cfg exists on the card.
  if (ab_paircfg_load(AB_PAIRCFG_PATH, &g_cfg) != 0) {
    memset(&g_cfg, 0, sizeof g_cfg);
    snprintf(g_cfg.psk_hex, sizeof g_cfg.psk_hex, "%s", PAIR_PSK);
    snprintf(g_cfg.host, sizeof g_cfg.host, "%s", SERVER_HOST);
    g_cfg.port = SERVER_PORT;
    snprintf(g_cfg.token, sizeof g_cfg.token, "%s", PAIR_TOKEN);
    if (g_cfg.psk_hex[0] == '\0') set_status("unpaired - press X to scan host QR");
  }

  bool config_error = false;
  if (ab_net_init() != 0) {
    set_status("soc init failed");
    config_error = true;
  } else if (ab_net_set_psk(g_cfg.psk_hex) != 0) {
    // PSK is set but malformed. Fail CLOSED: never fall back to plaintext,
    // which would send the token in the clear on every retry. Rescan or fix.
    set_status("bad PSK - press X to scan host QR");
    config_error = true;
  }
  g_ui.config_error = config_error;

  int reconnect_countdown = 0;

  while (aptMainLoop()) {
    hidScanInput();
    u32 down = hidKeysDown();
    u32 held = hidKeysHeld();
    if (down & KEY_START) break;

    // U6/U7: QR pairing is available whenever we're offline. A successful
    // scan installs a fresh (validated) PSK, so a bad-PSK config error clears.
    if (config_error || !ab_net_connected()) {
      if (handle_scan(down)) {
        if (ab_net_set_psk(g_cfg.psk_hex) == 0) {
          config_error = false;
          g_ui.config_error = false;
          reconnect_countdown = 0;
        }
      }
    }

    if (config_error) {
      ui_render(&g_ui); // show the error; do not touch the network
      continue;
    }

    if (!ab_net_connected()) {
      g_ui.connected = false;
      if (reconnect_countdown <= 0) {
        // Zero-config first (U27): one encrypted probe round per reconnect tick;
        // falls back to the paired/compiled-in host when nothing answers.
        char host[sizeof g_cfg.host];
        uint16_t port;
        if (ab_net_discover(DISCOVERY_PORT, host, sizeof host, &port) != 0) {
          if (g_cfg.host[0] == '\0') {
            // Discovery-only pairing and nobody answered: keep probing.
            reconnect_countdown = RECONNECT_FRAMES;
            ui_render(&g_ui);
            continue;
          }
          snprintf(host, sizeof host, "%s", g_cfg.host);
          port = g_cfg.port;
        }
        if (ab_net_connect(host, port) == 0) {
          ab_net_attach(g_cfg.token);
        } else {
          reconnect_countdown = RECONNECT_FRAMES;
        }
      } else {
        reconnect_countdown--;
      }
    } else {
      handle_buttons(down, held);

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

  if (g_scanning) ab_cam_stop();
  ab_net_shutdown();
  ab_alert_exit();
  ui_exit();
  return 0;
}
