// citro2d HUD for the 3DS client. COMPILES; runtime UNVERIFIED without hardware.
#ifndef AG3NT_UI_H
#define AG3NT_UI_H

#include <stdbool.h>

typedef struct {
  char agent[32];        // e.g. "codex" / "claude"
  char status[64];       // e.g. "thinking", "awaiting approval", "done"
  char output[1024];     // rolling tail of streamed agent output (top screen)
  bool connected;        // network state -> header + bottom hint
  bool approval_active;  // show the A=allow / B=deny deck
  char approval_detail[256];
} ui_state;

void ui_init(void);
void ui_render(const ui_state *st);
void ui_exit(void);

#endif // AG3NT_UI_H
