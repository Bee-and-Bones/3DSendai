// ag3nt 3DS client — main loop with auto-reconnect (M1/M2 device side).
// COMPILES with devkitPro; runtime UNVERIFIED without hardware.
//
// Connects to the host, streams agent output to a HUD, sends prompts (X), and
// approves/denies with A/B. Survives host restarts and 3DS sleep by
// reconnecting automatically.

#include <3ds.h>
#include <stdio.h>
#include <string.h>

#include "config.h"
#include "json.h"
#include "net.h"
#include "protocol.h"
#include "ui.h"

#define RECONNECT_FRAMES 120 // ~2s at 60fps between reconnect attempts

static ui_state g_ui;

static void set_status(const char *s) { snprintf(g_ui.status, sizeof(g_ui.status), "%s", s); }

static void on_frame(const ab_frame *f, void *ud) {
  (void)ud;
  const char *json = f->payload; // already NUL-terminated by ab_net_poll
  switch (f->type) {
    case AGENTBUS_MSG_HELLO:
      g_ui.connected = true;
      set_status("connected");
      break;
    case AGENTBUS_MSG_SESSION_LIST:
    case AGENTBUS_MSG_SESSION_STATE: {
      char agent[32], status[64];
      if (json_get_string(json, "agent", agent, sizeof(agent))) snprintf(g_ui.agent, sizeof(g_ui.agent), "%s", agent);
      if (json_get_string(json, "status", status, sizeof(status))) {
        set_status(status);
        if (strcmp(status, "done") == 0 || strcmp(status, "failed") == 0) g_ui.approval_active = false;
      }
      break;
    }
    case AGENTBUS_MSG_OUTPUT_CHUNK:
      if (!json_get_string(json, "text", g_ui.output, sizeof(g_ui.output)))
        snprintf(g_ui.output, sizeof(g_ui.output), "%s", json);
      break;
    case AGENTBUS_MSG_APPROVAL_REQUEST:
      g_ui.approval_active = true;
      if (!json_get_string(json, "detail", g_ui.approval_detail, sizeof(g_ui.approval_detail)))
        snprintf(g_ui.approval_detail, sizeof(g_ui.approval_detail), "%s", json);
      set_status("awaiting approval");
      break;
    case AGENTBUS_MSG_ERROR:
      if (!json_get_string(json, "message", g_ui.output, sizeof(g_ui.output)))
        snprintf(g_ui.output, sizeof(g_ui.output), "%s", json);
      set_status("error");
      break;
    default:
      break;
  }
}

static void send_prompt_via_keyboard(void) {
  SwkbdState kbd;
  char text[512];
  swkbdInit(&kbd, SWKBD_TYPE_NORMAL, 2, -1);
  swkbdSetHintText(&kbd, "prompt the agent");
  SwkbdButton btn = swkbdInputText(&kbd, text, sizeof(text));
  if (btn == SWKBD_BUTTON_CONFIRM) {
    char escaped[1024];
    json_escape_string(text, escaped, sizeof(escaped));
    char payload[1200];
    snprintf(payload, sizeof(payload), "{\"text\":\"%s\"}", escaped);
    ab_net_send(AGENTBUS_MSG_PROMPT_TEXT, 0, payload);
    set_status("thinking");
  }
}

static void send_approval(const char *decision) {
  char payload[128];
  snprintf(payload, sizeof(payload), "{\"approvalId\":\"pending\",\"decision\":\"%s\"}", decision);
  ab_net_send(AGENTBUS_MSG_APPROVAL_RESPONSE, 0, payload);
  g_ui.approval_active = false;
}

int main(void) {
  ui_init();
  snprintf(g_ui.agent, sizeof(g_ui.agent), "ag3nt");
  set_status("starting");

  if (ab_net_init() != 0) {
    set_status("soc init failed");
  }

  int reconnect_countdown = 0;

  while (aptMainLoop()) {
    hidScanInput();
    u32 down = hidKeysDown();
    if (down & KEY_START) break;

    if (!ab_net_connected()) {
      g_ui.connected = false;
      if (reconnect_countdown <= 0) {
        if (ab_net_connect(SERVER_HOST, SERVER_PORT) == 0) {
          ab_net_attach(PAIR_TOKEN);
        } else {
          reconnect_countdown = RECONNECT_FRAMES;
        }
      } else {
        reconnect_countdown--;
      }
    } else {
      if (down & KEY_X) send_prompt_via_keyboard();
      if (g_ui.approval_active) {
        if (down & KEY_A) send_approval("allow");
        if (down & KEY_B) send_approval("deny");
      }
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
