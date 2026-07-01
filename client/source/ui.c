// citro2d HUD. Top screen = header (agent + connection/status) + streamed
// output; bottom = context hint or approval deck. COMPILES; runtime UNVERIFIED.
// C2D_TextOptimize coalesces glyph sheets to avoid texture-swap frame drops.

#include "ui.h"

#include <3ds.h>
#include <citro2d.h>
#include <stdio.h>
#include <string.h>

static C3D_RenderTarget *s_top;
static C3D_RenderTarget *s_bottom;
static C2D_TextBuf s_buf;

static const u32 CLR_BG = 0xFF1E1E1E;
static const u32 CLR_HDR = 0xFF2A2A2A;
static const u32 CLR_FG = 0xFFF0F0F0;
static const u32 CLR_DIM = 0xFF9AA0A6;
static const u32 CLR_OK = 0xFF4CC24C;
static const u32 CLR_WARN = 0xFFE0B341;

void ui_init(void) {
  gfxInitDefault();
  C3D_Init(C3D_DEFAULT_CMDBUF_SIZE);
  C2D_Init(C2D_DEFAULT_MAX_OBJECTS);
  C2D_Prepare();
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

void ui_render(const ui_state *st) {
  C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
  C2D_TextBufClear(s_buf);

  // --- Top screen ---
  C2D_TargetClear(s_top, CLR_BG);
  C2D_SceneBegin(s_top);
  C2D_DrawRectSolid(0.0f, 0.0f, 0.0f, 400.0f, 24.0f, CLR_HDR);

  char header[128];
  const char *agent = st->agent[0] ? st->agent : "ag3nt";
  if (!st->connected) {
    snprintf(header, sizeof(header), "ag3nt \xC2\xB7 %s \xC2\xB7 reconnecting...", agent);
    draw_text(8.0f, 4.0f, 0.55f, CLR_WARN, header);
  } else {
    snprintf(header, sizeof(header), "ag3nt \xC2\xB7 %s \xC2\xB7 %s", agent, st->status[0] ? st->status : "idle");
    draw_text(8.0f, 4.0f, 0.55f, CLR_OK, header);
  }
  draw_text(8.0f, 34.0f, 0.5f, CLR_FG, st->output[0] ? st->output : "");

  // --- Bottom screen ---
  C2D_TargetClear(s_bottom, CLR_BG);
  C2D_SceneBegin(s_bottom);
  if (!st->connected) {
    draw_text(8.0f, 100.0f, 0.6f, CLR_WARN, "Reconnecting to host...");
    draw_text(8.0f, 130.0f, 0.45f, CLR_DIM, "Check the host is running and on the same WiFi.");
  } else if (st->approval_active) {
    draw_text(8.0f, 8.0f, 0.5f, CLR_FG, st->approval_detail[0] ? st->approval_detail : "Approve this action?");
    C2D_DrawRectSolid(0.0f, 110.0f, 0.0f, 320.0f, 40.0f, CLR_HDR);
    draw_text(12.0f, 120.0f, 0.7f, CLR_OK, "A  Allow");
    draw_text(180.0f, 120.0f, 0.7f, CLR_WARN, "B  Deny");
  } else {
    draw_text(8.0f, 8.0f, 0.5f, CLR_FG, "X  Prompt");
    draw_text(8.0f, 40.0f, 0.5f, CLR_DIM, "START  Quit");
  }

  C3D_FrameEnd(0);
}

void ui_exit(void) {
  C2D_TextBufDelete(s_buf);
  C2D_Fini();
  C3D_Fini();
  gfxExit();
}
