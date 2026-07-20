// U6 (plan 2026-07-20-001) — device-side agent board model. Pure C (no libctru),
// host-KAT'd by client/test/boardTest.c; the top-screen render + deck touch glue
// (ui.c/main.c, U7) are the hardware-only layer built directly on this API.
//
// Blocked-first ordering, the watched-screen approval gate, and the per-kind
// allowlist are ported (semantics, not code) from AgentSlate
// (https://github.com/DanielOu1208/agentslate, MIT, Daniel Ou): its dashboard
// sorts blocked agents to the top, and its accept/deny surface is gated to the
// same five agent kinds. See host/src/herdr/AGENTSLATE-PORT.md (U5) for the
// port provenance.
//
// The model holds every agent pane across every attached herdr session as a
// flat, fixed-capacity table. Rows carry the enriched SESSION_STATE fields
// (kind/agentName/status/title/workspace); ordering, the identity-tracked
// cursor, and the scroll viewport are all derived here so U7's glue stays
// render-only and every decision it makes is KAT-covered.
#ifndef SENDAI_BOARD_H
#define SENDAI_BOARD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AB_BOARD_CAP 16           // agent rows (blocked-preferring eviction on overflow)
#define AB_BOARD_NAME_CAP 32      // primary display text (agentName, falling back)
#define AB_BOARD_KIND_CAP 16      // stable agent identifier, e.g. "codex"
#define AB_BOARD_STATUS_CAP 16    // semantic status string (wire value, not label)
#define AB_BOARD_TITLE_CAP 40     // task title
#define AB_BOARD_WORKSPACE_CAP 24 // workspace label

// Frames between arming an Accept/Deny and the in-flight state auto-expiring
// when no status update for the row arrives (a double-tap must not send twice).
#define AB_BOARD_APPROVAL_COOLDOWN 120u

// Shift+Tab (back-tab) terminal byte sequence: ESC [ Z. U7's key bank sends it
// through the existing KEYSTROKE raw-byte path; defined once here so a KAT pins
// the exact bytes.
#define AB_SHIFT_TAB_LEN 3
extern const uint8_t ab_shift_tab_bytes[AB_SHIFT_TAB_LEN];

typedef struct {
  uint32_t session_id;
  char name[AB_BOARD_NAME_CAP];
  char kind[AB_BOARD_KIND_CAP];
  char status[AB_BOARD_STATUS_CAP];
  char title[AB_BOARD_TITLE_CAP];
  char workspace[AB_BOARD_WORKSPACE_CAP];
  bool used;
} ab_board_row;

typedef struct {
  ab_board_row rows[AB_BOARD_CAP]; // packed [0, count) in insertion order
  int order[AB_BOARD_CAP];         // row indices, blocked-first, stable within groups
  int count;

  uint32_t cursor_session; // selected session id (0 = none) — tracked by id, not row
  int scroll;              // viewport top in ordered space

  uint32_t inflight_session; // row with an armed approval (0 = none)
  uint32_t inflight_since;   // `now` at arm time (for the cooldown window)
} ab_board;

// Reset to empty (no rows, no cursor, no in-flight approval).
void ab_board_init(ab_board *b);

// Upsert a row keyed by session id: update in place when the id is present,
// otherwise insert. On overflow a non-blocked row is evicted (oldest first);
// when all 16 rows are blocked the insert is refused. An upsert is a status
// update for the row, so it clears any in-flight approval on that id. Absent
// fields (NULL/empty) are stored as empty strings; all copies are bounded and
// NUL-terminated. Returns 0 on insert/update, negative when refused.
int ab_board_upsert(ab_board *b, uint32_t session_id, const char *name, const char *kind,
                    const char *status, const char *title, const char *workspace);

// Remove the row for a session id (compacting the table and applying the
// nearest-row cursor fallback). Returns 0 when removed, negative when absent.
int ab_board_remove(ab_board *b, uint32_t session_id);

// Number of live rows.
int ab_board_count(const ab_board *b);

// Row at an ordered position (0 = first, blocked-first order). NULL out of range.
const ab_board_row *ab_board_row_at(const ab_board *b, int order_pos);

// Row for a session id, or NULL when absent.
const ab_board_row *ab_board_find(const ab_board *b, uint32_t session_id);

// --- cursor (identity-tracked; survives re-sorts and row removal) -----------

// Point the cursor at a session id (no-op identity change if the id is absent —
// stored regardless so a row arriving later resolves it).
void ab_board_cursor_set(ab_board *b, uint32_t session_id);

// The selected session id (0 = none).
uint32_t ab_board_cursor_id(const ab_board *b);

// Ordered position of the cursor, or -1 when none/unresolved.
int ab_board_cursor_pos(const ab_board *b);

// Move the cursor by `delta` in ordered space, clamped at both ends. With no
// current selection it lands on the first ordered row.
void ab_board_cursor_move(ab_board *b, int delta);

// The cursor's row, or NULL when none/unresolved.
const ab_board_row *ab_board_cursor_row(const ab_board *b);

// --- viewport ----------------------------------------------------------------

// Cursor-following scroll window: adjusts and clamps the stored top so the
// cursor stays within `visible` rows, then returns the top ordered index.
int ab_board_viewport_top(ab_board *b, int visible);

// --- deck predicates (U7's Accept/Deny + key bank read these) ---------------

// Is `kind` one of the five approval-mapped agent kinds?
bool ab_board_kind_allowlisted(const char *kind);

// Accept/Deny enabled: cursor row is blocked, its kind is allowlisted, and no
// approval is in flight for it (given the injected `now`).
bool ab_board_approval_enabled(const ab_board *b, uint32_t now);

// Arm an Accept/Deny on the cursor row: succeeds (returns true) only when
// currently enabled, and disables further sends for the row until a status
// update arrives or the cooldown elapses — exactly once under a double tap.
bool ab_board_arm_approval(ab_board *b, uint32_t now);

// Key bank / push-to-talk enabled: a session must be focused (caller supplies
// the focused id; 0 = none).
bool ab_board_keybank_enabled(uint32_t focused_id);

// --- display mapping ---------------------------------------------------------

// Short board label for a semantic status value (e.g. "running_tool" -> "working",
// "blocked" -> "BLOCKED"). Unrecognized/empty -> "unknown". Never NULL.
const char *ab_board_status_label(const char *status);

#endif // SENDAI_BOARD_H
