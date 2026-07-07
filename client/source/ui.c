// citro2d HUD. Top screen = focused session terminal grid (term.c + termfont.c).
// Bottom screen = terminal control strip + session picker + macropad toggle
// (U35), or a macropad placeholder (U36 stub). COMPILES; runtime UNVERIFIED.

#include "ui.h"

#include <3ds.h>
#include <citro2d.h>
#include <stdio.h>
#include <string.h>

#include "termfont.h"

static C3D_RenderTarget *s_top;
static C3D_RenderTarget *s_bottom;
static C2D_TextBuf s_buf;

static const u32 CLR_BG = 0xFF1E1E1E;
static const u32 CLR_FG = 0xFFF0F0F0;
static const u32 CLR_DIM = 0xFF9AA0A6;
static const u32 CLR_OK = 0xFF4CC24C;
static const u32 CLR_WARN = 0xFFE0B341;
static const u32 CLR_KEY = 0xFF3A3A3A;
static const u32 CLR_KEY_ON = 0xFF4C7CC2; // sticky Ctrl / mode highlight
static const u32 CLR_ROW = 0xFF262626;
static const u32 CLR_ROW_SEL = 0xFF2E4A2E;

// --- Bottom-screen control-strip layout (single source for draw + hit-test) ---
// One horizontal strip of labeled keys near the bottom of the 320x240 screen.
#define STRIP_Y 200.0f
#define STRIP_H 36.0f
#define STRIP_KEYS 9

typedef struct {
  ab_ui_hit hit;
  const char *label;
  float x, w;
} strip_key;

static const strip_key STRIP[STRIP_KEYS] = {
  {AB_HIT_KEY_CTRL, "Ctrl", 2.0f, 40.0f},
  {AB_HIT_KEY_ESC, "Esc", 44.0f, 34.0f},
  {AB_HIT_KEY_TAB, "Tab", 80.0f, 34.0f},
  {AB_HIT_KEY_LEFT, "<", 116.0f, 24.0f},
  {AB_HIT_KEY_DOWN, "v", 142.0f, 24.0f},
  {AB_HIT_KEY_UP, "^", 168.0f, 24.0f},
  {AB_HIT_KEY_RIGHT, ">", 194.0f, 24.0f},
  {AB_HIT_KEY_CTRLC, "^C", 220.0f, 34.0f},
  {AB_HIT_KEY_KEYBOARD, "Kbd", 256.0f, 60.0f},
};

// Mode-toggle button (top-right of the bottom screen, present in both modes).
#define TOGGLE_X 250.0f
#define TOGGLE_Y 4.0f
#define TOGGLE_W 66.0f
#define TOGGLE_H 24.0f

// Session picker rows.
#define ROW_X 4.0f
#define ROW_Y0 36.0f
#define ROW_W 312.0f
#define ROW_H 20.0f
#define ROW_GAP 2.0f

void ui_init(void) {
  gfxInitDefault();
  C3D_Init(C3D_DEFAULT_CMDBUF_SIZE);
  // U4: the terminal grid renders one atlas quad per non-blank cell (~1.2k
  // objects for a dense 50x24 screen), so the default 4096 object budget is
  // ample again. (The pre-atlas rect renderer needed 16384; it survives only
  // as termfont.c's R7 degradation path, where a dense screen may exceed the
  // budget and clip — degraded, not crashed.)
  C2D_Init(C2D_DEFAULT_MAX_OBJECTS);
  C2D_Prepare();
  ab_termfont_init(); // build the glyph atlas (degrades to rects on failure)
  s_top = C2D_CreateScreenTarget(GFX_TOP, GFX_LEFT);
  s_bottom = C2D_CreateScreenTarget(GFX_BOTTOM, GFX_LEFT);
  s_buf = C2D_TextBufNew(8192);
}

static void draw_text(float x, float y, float scale, u32 color, const char *str) {
  C2D_Text text;
  C2D_TextParse(&text, s_buf, str);
  C2D_TextOptimize(&text);
  C2D_DrawText(&text, C2D_WithColor, x, y, 0.0f, scale, scale, color);
}

static bool in_rect(int tx, int ty, float x, float y, float w, float h) {
  return tx >= x && tx < x + w && ty >= y && ty < y + h;
}

static void draw_key(const strip_key *k, bool on) {
  C2D_DrawRectSolid(k->x, STRIP_Y, 0.0f, k->w - 2.0f, STRIP_H, on ? CLR_KEY_ON : CLR_KEY);
  draw_text(k->x + 5.0f, STRIP_Y + 10.0f, 0.5f, CLR_FG, k->label);
}

static void render_control_strip(const ui_state *st) {
  // Session picker rows above the strip.
  for (int i = 0; i < st->session_count && i < AB_UI_MAX_SESSIONS; i++) {
    const ab_ui_session *s = &st->sessions[i];
    if (!s->used) continue;
    float ry = ROW_Y0 + (float)i * (ROW_H + ROW_GAP);
    bool sel = s->id == st->focused_id;
    C2D_DrawRectSolid(ROW_X, ry, 0.0f, ROW_W, ROW_H, sel ? CLR_ROW_SEL : CLR_ROW);
    char line[48];
    snprintf(line, sizeof(line), "%s%s", sel ? "> " : "  ", s->name[0] ? s->name : "session");
    draw_text(ROW_X + 4.0f, ry + 4.0f, 0.45f, sel ? CLR_OK : CLR_DIM, line);
  }
  if (st->session_count == 0)
    draw_text(ROW_X + 4.0f, ROW_Y0 + 4.0f, 0.45f, CLR_DIM, "waiting for sessions...");

  // Control-strip keys.
  for (int i = 0; i < STRIP_KEYS; i++) {
    bool on = STRIP[i].hit == AB_HIT_KEY_CTRL && st->ctrl_sticky;
    draw_key(&STRIP[i], on);
  }
}

// --- Macropad (U36): compiled-in quick-action grid --------------------------
// Each button sends fixed raw key bytes into the focused session (KEYSTROKE).
// Edit this table to reconfigure the pad (device build-time-config idiom, R36);
// it mirrors host `layouts/terminal.pad` / `keymap.ts`.
typedef struct {
  const char *label;
  const uint8_t keys[8];
  int len;
} pad_button;

static const pad_button PAD[] = {
  {"^C", {0x03}, 1},              // interrupt
  {"Enter", {0x0d}, 1},          // enter
  {"Esc", {0x1b}, 1},            // escape
  {"Tab", {0x09}, 1},            // tab
  {"Yes", {'y', 0x0d}, 2},       // approve (y + CR)
  {"No", {'n', 0x0d}, 2},        // deny (n + CR)
  {"Up", {0x1b, '[', 'A'}, 3},   // arrow up
  {"Down", {0x1b, '[', 'B'}, 3}, // arrow down
};
#define PAD_COUNT ((int)(sizeof(PAD) / sizeof(PAD[0])))

// Macropad grid geometry: 4 columns x 2 rows over the bottom screen.
#define PAD_COLS 4
#define PAD_X0 8.0f
#define PAD_Y0 60.0f
#define PAD_W 72.0f
#define PAD_H 60.0f
#define PAD_GAP 4.0f

static void pad_rect(int i, float *x, float *y) {
  int col = i % PAD_COLS, row = i / PAD_COLS;
  *x = PAD_X0 + (float)col * (PAD_W + PAD_GAP);
  *y = PAD_Y0 + (float)row * (PAD_H + PAD_GAP);
}

int ui_pad_count(void) { return PAD_COUNT; }

const uint8_t *ui_pad_keys(int index, int *out_len) {
  if (index < 0 || index >= PAD_COUNT) return NULL;
  if (out_len) *out_len = PAD[index].len;
  return PAD[index].keys;
}

// --- Alert log (U8): recent alerts, newest first; tap a row to mute/unmute
// that session (LED/tone suppressed, still logged).
#define ALERT_ROWS_VISIBLE 8

static const char *alert_class_name(uint8_t cls) {
  switch (cls) {
    case AB_ALERT_SESSION_ENDED: return "ended";
    case AB_ALERT_LIKELY_DONE: return "done";
    default: return "bell";
  }
}

// Name for a session id from the picker table; falls back to "s<id>".
static void session_label(const ui_state *st, uint32_t id, char *out, int cap) {
  for (int i = 0; i < st->session_count; i++) {
    if (st->sessions[i].used && st->sessions[i].id == id && st->sessions[i].name[0]) {
      snprintf(out, (size_t)cap, "%s", st->sessions[i].name);
      return;
    }
  }
  snprintf(out, (size_t)cap, "s%lu", (unsigned long)id);
}

static void render_alertlog(const ui_state *st) {
  if (!st->alerts || st->alerts->count == 0) {
    draw_text(ROW_X + 4.0f, ROW_Y0 + 4.0f, 0.45f, CLR_DIM, "no alerts yet");
    return;
  }
  draw_text(ROW_X + 4.0f, ROW_Y0 - 14.0f, 0.4f, CLR_DIM, "recent alerts - tap to mute a session");
  for (int i = 0; i < ALERT_ROWS_VISIBLE; i++) {
    const ab_alert_rec *r = ab_alertlog_get(st->alerts, i);
    if (!r) break;
    float ry = ROW_Y0 + (float)i * (ROW_H + ROW_GAP);
    bool muted = ab_alertlog_is_muted(st->alerts, r->session_id);
    C2D_DrawRectSolid(ROW_X, ry, 0.0f, ROW_W, ROW_H, muted ? CLR_ROW : CLR_ROW_SEL);
    char name[32], line[64];
    session_label(st, r->session_id, name, sizeof name);
    unsigned age_s = st->tick >= r->tick ? (st->tick - r->tick) / 60u : 0;
    snprintf(line, sizeof line, "%-12.12s %-5s ~%us ago%s", name, alert_class_name(r->cls),
             age_s, muted ? "  [muted]" : "");
    draw_text(ROW_X + 4.0f, ry + 4.0f, 0.45f, muted ? CLR_DIM : CLR_FG, line);
  }
}

static void render_macropad(const ui_state *st) {
  (void)st;
  for (int i = 0; i < PAD_COUNT; i++) {
    float x, y;
    pad_rect(i, &x, &y);
    C2D_DrawRectSolid(x, y, 0.0f, PAD_W, PAD_H, CLR_KEY);
    draw_text(x + 8.0f, y + 22.0f, 0.6f, CLR_FG, PAD[i].label);
  }
}

// U9 approval overlay: a band across the top screen showing the head of the
// approval queue. Drawn last so it sits over the terminal grid.
static void render_approval_overlay(const ui_state *st) {
  const ab_approval *a = ab_approvalq_head(st->approvals);
  if (!a) return;
  const float y0 = 70.0f, h = 96.0f;
  C2D_DrawRectSolid(0.0f, y0, 0.5f, 400.0f, h, 0xF0101018);
  C2D_DrawRectSolid(0.0f, y0, 0.5f, 400.0f, 2.0f, CLR_WARN);
  C2D_DrawRectSolid(0.0f, y0 + h - 2.0f, 0.5f, 400.0f, 2.0f, CLR_WARN);
  char line[140];
  snprintf(line, sizeof line, "APPROVAL [%s] %s", a->risk[0] ? a->risk : "?", a->tool);
  draw_text(10.0f, y0 + 8.0f, 0.55f, CLR_WARN, line);
  draw_text(10.0f, y0 + 32.0f, 0.45f, CLR_FG, a->detail);
  if (ab_approvalq_count(st->approvals) > 1) {
    snprintf(line, sizeof line, "A: allow   B: deny      (+%d more pending)",
             ab_approvalq_count(st->approvals) - 1);
  } else {
    snprintf(line, sizeof line, "A: allow   B: deny");
  }
  draw_text(10.0f, y0 + 64.0f, 0.5f, CLR_OK, line);
}

void ui_render(const ui_state *st) {
  C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
  C2D_TextBufClear(s_buf);

  // --- Top screen: the focused terminal grid (or status when there isn't one).
  C2D_TargetClear(s_top, CLR_BG);
  C2D_SceneBegin(s_top);
  if (st->config_error) {
    draw_text(8.0f, 100.0f, 0.6f, CLR_WARN, st->status[0] ? st->status : "config error");
  } else if (st->term) {
    ab_termfont_draw(st->term);
  } else if (!st->connected) {
    draw_text(8.0f, 100.0f, 0.55f, CLR_WARN, "reconnecting to host...");
  } else {
    draw_text(8.0f, 100.0f, 0.55f, CLR_DIM, "no session focused");
  }
  if (st->approvals) render_approval_overlay(st); // U9: over the grid

  // --- Bottom screen.
  C2D_TargetClear(s_bottom, CLR_BG);
  C2D_SceneBegin(s_bottom);

  // Header line: focused session + connection state.
  char header[128];
  const char *name = st->focused_name[0] ? st->focused_name : "3dsendai";
  snprintf(header, sizeof(header), "%.20s %s %.40s", name,
           st->connected ? "\xC2\xB7" : "(offline)", st->connected ? st->status : "");
  draw_text(4.0f, 6.0f, 0.5f, st->connected ? CLR_OK : CLR_WARN, header);

  // Mode toggle (always present); labeled with the NEXT mode in the cycle.
  C2D_DrawRectSolid(TOGGLE_X, TOGGLE_Y, 0.0f, TOGGLE_W, TOGGLE_H,
                    st->mode != AB_UI_MODE_TERMINAL ? CLR_KEY_ON : CLR_KEY);
  draw_text(TOGGLE_X + 6.0f, TOGGLE_Y + 6.0f, 0.45f, CLR_FG,
            st->mode == AB_UI_MODE_TERMINAL ? "Pad"
            : st->mode == AB_UI_MODE_MACROPAD ? "Alerts"
                                              : "Term");

  if (st->config_error) {
    draw_text(8.0f, 120.0f, 0.5f, CLR_WARN, "Scan the host QR (X) or fix config.h.");
  } else if (!st->connected) {
    draw_text(8.0f, 120.0f, 0.5f, CLR_WARN, "Reconnecting to host...");
    draw_text(8.0f, 150.0f, 0.4f, CLR_DIM, "X: pair by QR / check the host is on this WiFi.");
  } else if (st->mode == AB_UI_MODE_MACROPAD) {
    render_macropad(st);
  } else if (st->mode == AB_UI_MODE_ALERTS) {
    render_alertlog(st);
  } else {
    render_control_strip(st);
  }

  C3D_FrameEnd(0);
}

ab_ui_hit ui_hit_bottom(const ui_state *st, int tx, int ty) {
  // Mode toggle first (drawn in both modes).
  if (in_rect(tx, ty, TOGGLE_X, TOGGLE_Y, TOGGLE_W, TOGGLE_H)) return AB_HIT_MODE_TOGGLE;
  if (!st->connected || st->config_error) return AB_HIT_NONE;

  if (st->mode == AB_UI_MODE_TERMINAL) {
    for (int i = 0; i < STRIP_KEYS; i++) {
      if (in_rect(tx, ty, STRIP[i].x, STRIP_Y, STRIP[i].w - 2.0f, STRIP_H)) return STRIP[i].hit;
    }
    for (int i = 0; i < st->session_count && i < AB_UI_MAX_SESSIONS; i++) {
      if (!st->sessions[i].used) continue;
      float ry = ROW_Y0 + (float)i * (ROW_H + ROW_GAP);
      if (in_rect(tx, ty, ROW_X, ry, ROW_W, ROW_H))
        return (ab_ui_hit)(AB_HIT_SESSION_BASE + i);
    }
  } else if (st->mode == AB_UI_MODE_MACROPAD) {
    for (int i = 0; i < PAD_COUNT; i++) {
      float x, y;
      pad_rect(i, &x, &y);
      if (in_rect(tx, ty, x, y, PAD_W, PAD_H)) return (ab_ui_hit)(AB_HIT_PAD_BASE + i);
    }
  } else if (st->mode == AB_UI_MODE_ALERTS && st->alerts) {
    int rows = st->alerts->count < ALERT_ROWS_VISIBLE ? st->alerts->count : ALERT_ROWS_VISIBLE;
    for (int i = 0; i < rows; i++) {
      float ry = ROW_Y0 + (float)i * (ROW_H + ROW_GAP);
      if (in_rect(tx, ty, ROW_X, ry, ROW_W, ROW_H)) return (ab_ui_hit)(AB_HIT_ALERT_BASE + i);
    }
  }
  return AB_HIT_NONE;
}

void ui_exit(void) {
  C2D_TextBufDelete(s_buf);
  C2D_Fini();
  C3D_Fini();
  gfxExit();
}
