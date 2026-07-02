// U33 — terminal emulator core: pure-C VT/ANSI parser + cell grid + scrollback.
// COMPILES with devkitPro; runtime UNVERIFIED without hardware. NO libctru here
// so this file host-compiles for the term_test.c KAT (client/test/run.sh).
//
// Scope per KTD2: a scrolling-log renderer with a minimal ANSI/SGR state machine
// (printable, CSI cursor moves, \e[K erase, SGR colors, CR/LF/backspace/tab, line
// wrap) + a scrollback ring. Alt-screen apps are ignored/best-effort.
//
// Grid geometry is in #defines so a later hardware test (S4) can tune it cheaply.
#ifndef SENDAI_TERM_H
#define SENDAI_TERM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// --- Parameterized grid geometry (S4-tunable) --------------------------------
// Top screen is 400x240. 50 cols * 8px = 400; 24 rows * 10px = 240.
#define AB_TERM_COLS 50
#define AB_TERM_ROWS 24
#define AB_TERM_SCROLLBACK 512 // total ring rows (visible ROWS included)

// --- SGR attribute byte -------------------------------------------------------
// Packed per cell: bits 0-3 fg color index, bits 4-7 bg color index, bit 8 bold,
// bit 9 inverse. Colors are the 8 ANSI base indices (0-7); default is index 9.
#define AB_ATTR_FG_MASK 0x000F
#define AB_ATTR_BG_MASK 0x00F0
#define AB_ATTR_BG_SHIFT 4
#define AB_ATTR_BOLD 0x0100
#define AB_ATTR_INVERSE 0x0200
#define AB_ATTR_DEFAULT_COLOR 9 // "use the renderer's default fg/bg"

// Default attr: default fg (9), default bg (9), no bold/inverse.
#define AB_ATTR_DEFAULT \
  ((uint16_t)(AB_ATTR_DEFAULT_COLOR | (AB_ATTR_DEFAULT_COLOR << AB_ATTR_BG_SHIFT)))

typedef struct {
  char ch;       // printable ASCII 0x20-0x7E; ' ' for blank
  uint16_t attr; // SGR attribute bits (AB_ATTR_*)
} ab_cell;

// Escape-parser state machine phases.
typedef enum {
  AB_TS_GROUND = 0, // normal: printable/control bytes
  AB_TS_ESC,        // saw ESC (0x1b), awaiting the next byte
  AB_TS_CSI         // inside a CSI sequence (\e[ ...), collecting params
} ab_term_phase;

#define AB_TERM_CSI_MAX 32 // max bytes buffered for one CSI sequence

typedef struct {
  // Ring of rows; row_base is the ring index of the top-most stored row. The
  // visible region is the last ROWS rows written; scroll_off pans up into
  // history (0 = pinned to the live bottom).
  ab_cell rows[AB_TERM_SCROLLBACK][AB_TERM_COLS];
  int row_base;  // ring index of logical row 0 (oldest retained)
  int row_count; // number of logical rows currently stored (<= SCROLLBACK)
  int scroll_off; // rows scrolled up from the bottom (>=0)

  // Cursor position within the live (bottom) screen: 0..ROWS-1, 0..COLS-1.
  int cur_row;
  int cur_col;
  uint16_t cur_attr; // current SGR attribute applied to printed cells

  // Escape state machine.
  ab_term_phase phase;
  char csi[AB_TERM_CSI_MAX];
  int csi_len;
} ab_term;

// Reset to a blank grid, cursor home, default attr, ground state.
void ab_term_init(ab_term *t);
void ab_term_reset(ab_term *t);

// Feed raw pane bytes through the state machine (drives the whole emulator).
void ab_term_feed(ab_term *t, const uint8_t *data, size_t len);

// Read one visible cell. row 0..ROWS-1 top-to-bottom of the CURRENT view
// (accounts for scroll_off), col 0..COLS-1. Out-of-range yields a blank cell.
ab_cell ab_term_cell(const ab_term *t, int row, int col);

// Scrollback control. Positive delta scrolls up into history, negative toward
// the live bottom; clamped to [0, max]. scroll_to_bottom pins to live output.
void ab_term_scroll(ab_term *t, int delta);
void ab_term_scroll_to_bottom(ab_term *t);

// Current scroll offset (rows above the live bottom) and its clamp ceiling.
int ab_term_scroll_offset(const ab_term *t);
int ab_term_scroll_max(const ab_term *t);

// Cursor accessors (position within the visible live screen).
int ab_term_cursor_row(const ab_term *t);
int ab_term_cursor_col(const ab_term *t);

#endif // SENDAI_TERM_H
