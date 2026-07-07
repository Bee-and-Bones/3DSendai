// U33 — terminal emulator core (pure C, no libctru). COMPILES with devkitPro;
// runtime UNVERIFIED without hardware. Host-compiles for the term_test.c KAT.
//
// Model: a ring of AB_TERM_SCROLLBACK rows. The "live screen" is always the last
// AB_TERM_ROWS logical rows; scrollback is the history above it. The cursor
// addresses rows 0..ROWS-1 within the live screen. LF past the bottom pushes a
// fresh blank row into the ring (old rows fall off the top into unreachable
// history once row_count == SCROLLBACK).
//
// The escape parser is a small three-state machine (GROUND/ESC/CSI). Partial or
// malformed sequences are buffered/absorbed without corrupting the grid — an
// incomplete CSI split across two feeds resumes cleanly.

#include "term.h"

#include <string.h>

// --- ring helpers ------------------------------------------------------------

static ab_cell *ring_row(ab_term *t, int logical) {
  int idx = (t->row_base + logical) % AB_TERM_SCROLLBACK;
  return t->rows[idx];
}

static const ab_cell *ring_row_c(const ab_term *t, int logical) {
  int idx = (t->row_base + logical) % AB_TERM_SCROLLBACK;
  return t->rows[idx];
}

static void blank_row(ab_cell *row) {
  for (int c = 0; c < AB_TERM_COLS; c++) {
    row[c].ch = ' ';
    row[c].attr = AB_ATTR_DEFAULT;
  }
}

// Logical index of the first live-screen row (top of the bottom ROWS rows).
static int live_top(const ab_term *t) {
  return t->row_count > AB_TERM_ROWS ? t->row_count - AB_TERM_ROWS : 0;
}

// Live-screen row (0..ROWS-1) -> writable ring row.
static ab_cell *live_row(ab_term *t, int screen_row) {
  return ring_row(t, live_top(t) + screen_row);
}

// Push one fresh blank row at the bottom, scrolling the ring. Keeps at least
// ROWS rows present and caps history at SCROLLBACK by advancing row_base.
static void push_line(ab_term *t) {
  if (t->row_count < AB_TERM_SCROLLBACK) {
    ab_cell *row = ring_row(t, t->row_count);
    blank_row(row);
    t->row_count++;
  } else {
    // Full ring: oldest row is overwritten as the new bottom.
    ab_cell *row = t->rows[t->row_base];
    blank_row(row);
    t->row_base = (t->row_base + 1) % AB_TERM_SCROLLBACK;
  }
}

// --- lifecycle ---------------------------------------------------------------

void ab_term_reset(ab_term *t) {
  memset(t, 0, sizeof(*t));
  t->row_base = 0;
  t->row_count = AB_TERM_ROWS; // start with a full blank live screen
  for (int r = 0; r < AB_TERM_ROWS; r++) blank_row(t->rows[r]);
  t->scroll_off = 0;
  t->cur_row = 0;
  t->cur_col = 0;
  t->cur_attr = AB_ATTR_DEFAULT;
  t->phase = AB_TS_GROUND;
  t->csi_len = 0;
}

void ab_term_init(ab_term *t) { ab_term_reset(t); }

// --- cursor / editing primitives ---------------------------------------------

static void clamp_cursor(ab_term *t) {
  if (t->cur_row < 0) t->cur_row = 0;
  if (t->cur_row >= AB_TERM_ROWS) t->cur_row = AB_TERM_ROWS - 1;
  if (t->cur_col < 0) t->cur_col = 0;
  if (t->cur_col > AB_TERM_COLS) t->cur_col = AB_TERM_COLS; // COLS = "pending wrap"
}

static void line_feed(ab_term *t) {
  // Newline = down AND carriage return. tmux control-mode %output sends bare LF
  // (no CR) for line breaks, so LF must reset the column or every line staircases
  // to the right. (For CRLF input the CR already zeroed the column; this is a
  // harmless no-op then.) The deferred-wrap caller also zeroes col before us.
  t->cur_col = 0;
  if (t->cur_row >= AB_TERM_ROWS - 1) {
    push_line(t); // scroll: bottom row becomes fresh blank, cursor stays at bottom
    t->cur_row = AB_TERM_ROWS - 1;
  } else {
    t->cur_row++;
  }
}

static void put_char(ab_term *t, char ch) {
  if (t->cur_col >= AB_TERM_COLS) { // deferred wrap: move to next line first
    t->cur_col = 0;
    line_feed(t);
  }
  ab_cell *row = live_row(t, t->cur_row);
  row[t->cur_col].ch = ch;
  row[t->cur_col].attr = t->cur_attr;
  t->cur_col++;
}

// Erase to end of the current line (\e[K with no/param 0).
static void erase_line_to_end(ab_term *t) {
  ab_cell *row = live_row(t, t->cur_row);
  int start = t->cur_col < AB_TERM_COLS ? t->cur_col : AB_TERM_COLS - 1;
  for (int c = start; c < AB_TERM_COLS; c++) {
    row[c].ch = ' ';
    row[c].attr = AB_ATTR_DEFAULT;
  }
}

static void erase_line_to_start(ab_term *t) {
  ab_cell *row = live_row(t, t->cur_row);
  int end = t->cur_col < AB_TERM_COLS ? t->cur_col : AB_TERM_COLS - 1;
  for (int c = 0; c <= end; c++) {
    row[c].ch = ' ';
    row[c].attr = AB_ATTR_DEFAULT;
  }
}

static void erase_line_all(ab_term *t) {
  blank_row(live_row(t, t->cur_row));
}

static void erase_screen_to_end(ab_term *t) {
  erase_line_to_end(t);
  for (int r = t->cur_row + 1; r < AB_TERM_ROWS; r++) blank_row(live_row(t, r));
}

static void erase_screen_all(ab_term *t) {
  for (int r = 0; r < AB_TERM_ROWS; r++) blank_row(live_row(t, r));
}

// --- CSI handling ------------------------------------------------------------

// Parse up to `max` semicolon-separated integer params from the CSI buffer
// (excluding the trailing final byte). Missing params default to `dflt`.
// Every out[0..max) is written: callers read fixed positions (e.g. CUP reads
// p[1] even for a bare ESC[H), so unparsed slots must hold the default, not
// stack garbage — reading them was UB that clamped to column 49 under gcc.
static int csi_params(const ab_term *t, int *out, int max, int dflt) {
  for (int i = 0; i < max; i++) out[i] = dflt;
  int n = 0;
  int val = 0;
  bool have = false;
  for (int i = 0; i < t->csi_len && n < max; i++) {
    char c = t->csi[i];
    if (c >= '0' && c <= '9') {
      val = val * 10 + (c - '0');
      have = true;
    } else if (c == ';') {
      out[n++] = have ? val : dflt;
      val = 0;
      have = false;
    }
    // '?' and other intermediates are skipped; a leading '?' marks private modes.
  }
  if (n < max) out[n++] = have ? val : dflt;
  return n;
}

static bool csi_is_private(const ab_term *t) {
  return t->csi_len > 0 && t->csi[0] == '?';
}

// Map one SGR code onto the current attribute.
static void apply_sgr_code(ab_term *t, int code) {
  if (code == 0) {
    t->cur_attr = AB_ATTR_DEFAULT;
  } else if (code == 1) {
    t->cur_attr |= AB_ATTR_BOLD;
  } else if (code == 7) {
    t->cur_attr |= AB_ATTR_INVERSE;
  } else if (code == 22) {
    t->cur_attr &= (uint16_t)~AB_ATTR_BOLD;
  } else if (code == 27) {
    t->cur_attr &= (uint16_t)~AB_ATTR_INVERSE;
  } else if (code >= 30 && code <= 37) {
    t->cur_attr = (uint16_t)((t->cur_attr & ~AB_ATTR_FG_MASK) | (code - 30));
  } else if (code == 39) {
    t->cur_attr = (uint16_t)((t->cur_attr & ~AB_ATTR_FG_MASK) | AB_ATTR_DEFAULT_COLOR);
  } else if (code >= 40 && code <= 47) {
    t->cur_attr =
        (uint16_t)((t->cur_attr & ~AB_ATTR_BG_MASK) | ((code - 40) << AB_ATTR_BG_SHIFT));
  } else if (code == 49) {
    t->cur_attr = (uint16_t)((t->cur_attr & ~AB_ATTR_BG_MASK) |
                             (AB_ATTR_DEFAULT_COLOR << AB_ATTR_BG_SHIFT));
  }
  // 90-97 bright fg / 100-107 bright bg fold onto the 8 base colors (bold-ish);
  // ignored beyond the base set to keep the palette small.
}

static void apply_sgr(ab_term *t) {
  int params[16];
  int n = csi_params(t, params, 16, 0);
  for (int i = 0; i < n; i++) apply_sgr_code(t, params[i]);
}

static void dispatch_csi(ab_term *t, char final) {
  int p[4];
  switch (final) {
    case 'H': // CUP: cursor position (row;col, 1-based; default 1;1 = home)
    case 'f': {
      csi_params(t, p, 2, 1);
      t->cur_row = p[0] - 1;
      t->cur_col = p[1] - 1;
      clamp_cursor(t);
      break;
    }
    case 'A': // CUU up
      csi_params(t, p, 1, 1);
      t->cur_row -= p[0] > 0 ? p[0] : 1;
      clamp_cursor(t);
      break;
    case 'B': // CUD down
      csi_params(t, p, 1, 1);
      t->cur_row += p[0] > 0 ? p[0] : 1;
      clamp_cursor(t);
      break;
    case 'C': // CUF forward
      csi_params(t, p, 1, 1);
      t->cur_col += p[0] > 0 ? p[0] : 1;
      clamp_cursor(t);
      break;
    case 'D': // CUB back
      csi_params(t, p, 1, 1);
      t->cur_col -= p[0] > 0 ? p[0] : 1;
      clamp_cursor(t);
      break;
    case 'G': // CHA: cursor to column
      csi_params(t, p, 1, 1);
      t->cur_col = p[0] - 1;
      clamp_cursor(t);
      break;
    case 'd': // VPA: cursor to row
      csi_params(t, p, 1, 1);
      t->cur_row = p[0] - 1;
      clamp_cursor(t);
      break;
    case 'K': { // EL: erase in line (0=to end,1=to start,2=all)
      csi_params(t, p, 1, 0);
      if (p[0] == 1) erase_line_to_start(t);
      else if (p[0] == 2) erase_line_all(t);
      else erase_line_to_end(t);
      break;
    }
    case 'J': { // ED: erase in display (0=to end,2=all). 1 (to start) -> all.
      csi_params(t, p, 1, 0);
      if (p[0] == 2 || p[0] == 3 || p[0] == 1) erase_screen_all(t);
      else erase_screen_to_end(t);
      break;
    }
    case 'm': // SGR
      apply_sgr(t);
      break;
    case 'h': // set mode — ignore (incl. private \e[?…h alt-screen, KTD2)
    case 'l': // reset mode — ignore
    default:
      // Unknown/unsupported final byte: absorbed, grid untouched.
      (void)csi_is_private;
      break;
  }
}

// --- state machine feed ------------------------------------------------------

static void feed_ground(ab_term *t, uint8_t b) {
  switch (b) {
    case 0x1b: // ESC
      t->phase = AB_TS_ESC;
      break;
    case '\r': // CR
      t->cur_col = 0;
      break;
    case '\n': // LF
    case 0x0b: // VT -> treat as LF
    case 0x0c: // FF -> treat as LF
      line_feed(t);
      break;
    case '\b': // BS
      if (t->cur_col > 0) t->cur_col--;
      break;
    case '\t': { // HT: advance to next 8-col tab stop
      int next = (t->cur_col / 8 + 1) * 8;
      if (next >= AB_TERM_COLS) next = AB_TERM_COLS - 1;
      t->cur_col = next;
      break;
    }
    case 0x07: // BEL — no visual effect here (alert path is host-side)
      break;
    default:
      if (b >= 0x20 && b <= 0x7e) {
        put_char(t, (char)b);
      } else if (b >= 0x80) {
        // UTF-8 continuation/high bytes: render a placeholder so column math
        // stays sane without a full Unicode font (KTD2 log-scroll scope).
        // Only emit one glyph per lead byte; absorb continuation bytes.
        if ((b & 0xC0) != 0x80) put_char(t, '?');
      }
      break;
  }
}

static void feed_esc(ab_term *t, uint8_t b) {
  if (b == '[') {
    t->phase = AB_TS_CSI;
    t->csi_len = 0;
  } else if (b == 0x1b) {
    // Another ESC: stay in ESC (resync).
  } else {
    // \eM, \e7, \e8, \e(B, OSC \e], etc. — not modeled; drop the intro byte and
    // return to ground. OSC strings will spill their body as printable text; the
    // log-scroll scope accepts this best-effort behavior.
    t->phase = AB_TS_GROUND;
  }
}

static void feed_csi(ab_term *t, uint8_t b) {
  if (b >= 0x40 && b <= 0x7e) { // final byte
    dispatch_csi(t, (char)b);
    t->phase = AB_TS_GROUND;
    t->csi_len = 0;
  } else if (b == 0x1b) { // aborted by a new ESC: resync
    t->phase = AB_TS_ESC;
    t->csi_len = 0;
  } else {
    // Parameter/intermediate byte. Buffer it; overflow -> abandon this sequence
    // safely (absorb the rest until a final byte) rather than smash the grid.
    if (t->csi_len < AB_TERM_CSI_MAX) t->csi[t->csi_len++] = (char)b;
  }
}

void ab_term_feed(ab_term *t, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    uint8_t b = data[i];
    switch (t->phase) {
      case AB_TS_GROUND: feed_ground(t, b); break;
      case AB_TS_ESC: feed_esc(t, b); break;
      case AB_TS_CSI: feed_csi(t, b); break;
    }
  }
  // New output pins the view to the live bottom (matches terminal UX).
  t->scroll_off = 0;
}

// --- read-out / scrollback ---------------------------------------------------

int ab_term_scroll_max(const ab_term *t) {
  int extra = t->row_count - AB_TERM_ROWS;
  return extra > 0 ? extra : 0;
}

ab_cell ab_term_cell(const ab_term *t, int row, int col) {
  ab_cell blank;
  blank.ch = ' ';
  blank.attr = AB_ATTR_DEFAULT;
  if (row < 0 || row >= AB_TERM_ROWS || col < 0 || col >= AB_TERM_COLS) return blank;
  int top = live_top(t) - t->scroll_off; // pan up into history
  if (top < 0) top = 0;
  int logical = top + row;
  if (logical < 0 || logical >= t->row_count) return blank;
  return ring_row_c(t, logical)[col];
}

void ab_term_scroll(ab_term *t, int delta) {
  int off = t->scroll_off + delta;
  int max = ab_term_scroll_max(t);
  if (off < 0) off = 0;
  if (off > max) off = max;
  t->scroll_off = off;
}

void ab_term_scroll_to_bottom(ab_term *t) { t->scroll_off = 0; }

int ab_term_scroll_offset(const ab_term *t) { return t->scroll_off; }

int ab_term_cursor_row(const ab_term *t) { return t->cur_row; }

int ab_term_cursor_col(const ab_term *t) {
  return t->cur_col < AB_TERM_COLS ? t->cur_col : AB_TERM_COLS - 1;
}
