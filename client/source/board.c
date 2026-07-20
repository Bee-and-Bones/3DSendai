// U6 (plan 2026-07-20-001) — agent board model. See board.h. Pure C, no libctru;
// host-KAT'd by client/test/boardTest.c. Blocked-first ordering, the approval
// gate, and the five-kind allowlist port AgentSlate's supervision semantics
// (MIT, Daniel Ou) onto our device — code is ours, the model is theirs.

#include "board.h"

#include <stdio.h>
#include <string.h>

const uint8_t ab_shift_tab_bytes[AB_SHIFT_TAB_LEN] = {0x1B, 0x5B, 0x5A};

// The compiled approval allowlist: only these agent kinds get Accept/Deny
// (cosmetic device gate; the host revalidates against a fresh snapshot). Ported
// from AgentSlate's send-action allowlist.
static const char *const s_allowlist[] = {"codex", "cursor", "claude", "omp", "opencode"};
#define AB_ALLOWLIST_LEN (int)(sizeof(s_allowlist) / sizeof(s_allowlist[0]))

static bool row_blocked(const ab_board_row *r) {
  return strcmp(r->status, "blocked") == 0;
}

// Rebuild the blocked-first index array: blocked rows in insertion order, then
// non-blocked rows in insertion order (a stable partition — ties keep order).
static void board_reorder(ab_board *b) {
  int n = 0;
  for (int i = 0; i < b->count; i++)
    if (row_blocked(&b->rows[i])) b->order[n++] = i;
  for (int i = 0; i < b->count; i++)
    if (!row_blocked(&b->rows[i])) b->order[n++] = i;
}

static void row_set_fields(ab_board_row *r, uint32_t id, const char *name, const char *kind,
                           const char *status, const char *title, const char *workspace) {
  r->session_id = id;
  r->used = true;
  snprintf(r->name, sizeof r->name, "%s", name ? name : "");
  snprintf(r->kind, sizeof r->kind, "%s", kind ? kind : "");
  snprintf(r->status, sizeof r->status, "%s", status ? status : "");
  snprintf(r->title, sizeof r->title, "%s", title ? title : "");
  snprintf(r->workspace, sizeof r->workspace, "%s", workspace ? workspace : "");
}

void ab_board_init(ab_board *b) {
  memset(b, 0, sizeof *b);
  b->count = 0;
  b->cursor_session = 0;
  b->scroll = 0;
  b->inflight_session = 0;
  b->inflight_since = 0;
}

int ab_board_count(const ab_board *b) {
  return b->count;
}

const ab_board_row *ab_board_row_at(const ab_board *b, int order_pos) {
  if (order_pos < 0 || order_pos >= b->count) return (const ab_board_row *)0;
  return &b->rows[b->order[order_pos]];
}

const ab_board_row *ab_board_find(const ab_board *b, uint32_t session_id) {
  for (int i = 0; i < b->count; i++)
    if (b->rows[i].used && b->rows[i].session_id == session_id) return &b->rows[i];
  return (const ab_board_row *)0;
}

int ab_board_cursor_pos(const ab_board *b) {
  if (b->cursor_session == 0) return -1;
  for (int i = 0; i < b->count; i++)
    if (b->rows[b->order[i]].session_id == b->cursor_session) return i;
  return -1;
}

// Drop the row at raw index `idx`, compacting the table. Applies the nearest-row
// cursor fallback (the row that inherits the cursor's old ordered slot, clamped)
// and clears any in-flight approval tied to the removed id.
static void board_remove_index(ab_board *b, int idx) {
  uint32_t removed = b->rows[idx].session_id;
  bool cursor_removed = (b->cursor_session == removed);
  int cur_pos = ab_board_cursor_pos(b); // in the pre-removal ordering

  if (removed == b->inflight_session) b->inflight_session = 0;

  for (int i = idx; i < b->count - 1; i++)
    b->rows[i] = b->rows[i + 1];
  b->count--;
  memset(&b->rows[b->count], 0, sizeof b->rows[b->count]);
  board_reorder(b);

  if (cursor_removed) {
    if (b->count == 0) {
      b->cursor_session = 0;
    } else {
      int pos = cur_pos;
      if (pos < 0) pos = 0;
      if (pos >= b->count) pos = b->count - 1;
      b->cursor_session = b->rows[b->order[pos]].session_id;
    }
  }
}

int ab_board_upsert(ab_board *b, uint32_t session_id, const char *name, const char *kind,
                    const char *status, const char *title, const char *workspace) {
  // Update in place when present.
  for (int i = 0; i < b->count; i++) {
    if (b->rows[i].used && b->rows[i].session_id == session_id) {
      row_set_fields(&b->rows[i], session_id, name, kind, status, title, workspace);
      if (session_id == b->inflight_session) b->inflight_session = 0; // status update clears it
      board_reorder(b);
      return 0;
    }
  }

  int idx;
  if (b->count < AB_BOARD_CAP) {
    idx = b->count++;
  } else {
    // Overflow: evict the oldest non-blocked row; refuse when all are blocked.
    int victim = -1;
    for (int i = 0; i < b->count; i++)
      if (!row_blocked(&b->rows[i])) {
        victim = i;
        break;
      }
    if (victim < 0) return -1;
    board_remove_index(b, victim);
    idx = b->count++;
  }

  row_set_fields(&b->rows[idx], session_id, name, kind, status, title, workspace);
  if (session_id == b->inflight_session) b->inflight_session = 0;
  if (b->cursor_session == 0) b->cursor_session = session_id; // land the cursor on the first row
  board_reorder(b);
  return 0;
}

int ab_board_remove(ab_board *b, uint32_t session_id) {
  for (int i = 0; i < b->count; i++) {
    if (b->rows[i].used && b->rows[i].session_id == session_id) {
      board_remove_index(b, i);
      return 0;
    }
  }
  return -1;
}

void ab_board_cursor_set(ab_board *b, uint32_t session_id) {
  b->cursor_session = session_id;
}

uint32_t ab_board_cursor_id(const ab_board *b) {
  return b->cursor_session;
}

void ab_board_cursor_move(ab_board *b, int delta) {
  if (b->count == 0) {
    b->cursor_session = 0;
    return;
  }
  int pos = ab_board_cursor_pos(b);
  if (pos < 0)
    pos = 0;
  else
    pos += delta;
  if (pos < 0) pos = 0;
  if (pos >= b->count) pos = b->count - 1;
  b->cursor_session = b->rows[b->order[pos]].session_id;
}

const ab_board_row *ab_board_cursor_row(const ab_board *b) {
  int pos = ab_board_cursor_pos(b);
  return pos < 0 ? (const ab_board_row *)0 : &b->rows[b->order[pos]];
}

int ab_board_viewport_top(ab_board *b, int visible) {
  if (visible <= 0) {
    b->scroll = 0;
    return 0;
  }
  int cur = ab_board_cursor_pos(b);
  if (cur >= 0) {
    if (cur < b->scroll)
      b->scroll = cur;
    else if (cur >= b->scroll + visible)
      b->scroll = cur - visible + 1;
  }
  int maxtop = b->count - visible;
  if (maxtop < 0) maxtop = 0;
  if (b->scroll > maxtop) b->scroll = maxtop;
  if (b->scroll < 0) b->scroll = 0;
  return b->scroll;
}

bool ab_board_kind_allowlisted(const char *kind) {
  if (!kind || !kind[0]) return false;
  for (int i = 0; i < AB_ALLOWLIST_LEN; i++)
    if (strcmp(kind, s_allowlist[i]) == 0) return true;
  return false;
}

// True while an armed approval on `now`'s row is still within its cooldown.
static bool board_inflight(const ab_board *b, uint32_t now) {
  return b->inflight_session != 0 && (now - b->inflight_since) < AB_BOARD_APPROVAL_COOLDOWN;
}

bool ab_board_approval_enabled(const ab_board *b, uint32_t now) {
  const ab_board_row *r = ab_board_cursor_row(b);
  if (!r) return false;
  if (!row_blocked(r)) return false;
  if (!ab_board_kind_allowlisted(r->kind)) return false;
  if (board_inflight(b, now) && b->inflight_session == r->session_id) return false;
  return true;
}

bool ab_board_arm_approval(ab_board *b, uint32_t now) {
  if (!ab_board_approval_enabled(b, now)) return false;
  b->inflight_session = b->cursor_session;
  b->inflight_since = now;
  return true;
}

bool ab_board_keybank_enabled(uint32_t focused_id) {
  return focused_id != 0;
}

const char *ab_board_status_label(const char *status) {
  if (!status) return "unknown";
  if (strcmp(status, "running_tool") == 0) return "working";
  if (strcmp(status, "blocked") == 0) return "BLOCKED";
  if (strcmp(status, "awaiting_approval") == 0) return "approval?";
  if (strcmp(status, "thinking") == 0) return "thinking";
  if (strcmp(status, "done") == 0) return "done";
  if (strcmp(status, "idle") == 0) return "idle";
  if (strcmp(status, "failed") == 0) return "failed";
  return "unknown"; // "unknown" and any unrecognized/empty value
}
