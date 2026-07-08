// U33 — bundled monospace bitmap font + citro2d render helper for the terminal
// grid. COMPILES with devkitPro; runtime UNVERIFIED without hardware. This file
// MAY use citro2d — it is kept separate from the pure-C term.c so the parser
// host-compiles for the KAT.
//
// Font: an 8x8 monospace bitmap (font8x8_basic, public domain — Daniel Hepper),
// ASCII 0x20-0x7E. The system font is proportional and cannot column-align, so a
// bundled fixed-cell font is required (per the plan / DSSH reference). Cell size
// is #defined so a hardware pass (S4) can tune it.
#ifndef SENDAI_TERMFONT_H
#define SENDAI_TERMFONT_H

#include "term.h"

// Cell size in pixels. 50 cols * 8 = 400 (full top-screen width); 24 rows * 10 =
// 240 (full height). The 8x8 glyph is drawn top-left in the 8x10 cell (2px
// leading below), so descenders on g/j/p/q/y still read.
#define AB_TERMFONT_SCALE 1
#define AB_TERMFONT_GLYPH_W 8
#define AB_TERMFONT_GLYPH_H 8
#define AB_TERMFONT_CELL_W 8
#define AB_TERMFONT_CELL_H 10

// Origin of the grid on the top screen (top-left). Full-bleed at (0,0).
#define AB_TERMFONT_ORIGIN_X 0.0f
#define AB_TERMFONT_ORIGIN_Y 0.0f

// --- U4 (plan-004) glyph atlas geometry — pure C, host-KAT'd in
// client/test/atlas_test.c. The atlas is a GPU_A8 texture holding all 95
// printable glyphs, one glyph per 8x8 GPU tile, so writing a glyph needs only
// the fixed 64-entry Morton (Z-order) swizzle below — never a general
// row-major->tiled transform. Tiles are laid out row-major: 128px wide = 16
// tiles per row, 95 glyphs fill rows 0..5 of a 128x64 texture (128 tiles).
// Keep these helpers free of libctru so they host-compile for the KAT.

#include <stdint.h>

#define AB_ATLAS_W 128
#define AB_ATLAS_H 64
#define AB_ATLAS_TILE 8
#define AB_ATLAS_TILES_X (AB_ATLAS_W / AB_ATLAS_TILE)
#define AB_ATLAS_GLYPHS 95

// Printable char -> tile index (0..94), or -1 outside 0x20..0x7E.
static inline int ab_atlas_tile_index(char ch) {
  return (ch < 0x20 || ch > 0x7e) ? -1 : (int)ch - 0x20;
}
static inline int ab_atlas_tile_x(int idx) {
  return idx % AB_ATLAS_TILES_X;
}
static inline int ab_atlas_tile_y(int idx) {
  return idx / AB_ATLAS_TILES_X;
}

// Intra-tile Morton offset for pixel (x, y), both 0..7: bits interleave as
// x0 y0 x1 y1 x2 y2 (x least significant). This is the PICA200 8x8 tile order.
static inline int ab_atlas_morton(int x, int y) {
  return (x & 1) | ((y & 1) << 1) | ((x & 2) << 1) | ((y & 2) << 2) | ((x & 4) << 2) |
         ((y & 4) << 3);
}

// Byte offset of pixel (x, y) of glyph tile `idx` in the A8 atlas (1 byte/px).
// Tiles are 64 bytes, row-major over the 16-tile-wide texture.
static inline int ab_atlas_byte_offset(int idx, int x, int y) {
  return (ab_atlas_tile_y(idx) * AB_ATLAS_TILES_X + ab_atlas_tile_x(idx)) * 64 +
         ab_atlas_morton(x, y);
}

// Expand one font8x8 glyph (8 row bytes, bit 0 = leftmost column) into a
// 64-byte Morton-ordered A8 tile: 0xFF for lit pixels, 0x00 elsewhere.
static inline void ab_atlas_expand_glyph(const uint8_t rows[8], uint8_t out[64]) {
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++)
      out[ab_atlas_morton(x, y)] = ((rows[y] >> x) & 1) ? 0xFF : 0x00;
}

// Build the glyph atlas texture. Call once after C2D_Prepare(). On texture
// allocation failure the renderer degrades to the run-coalesced rect path (R7)
// — the terminal stays usable, just object-budget-hungrier.
void ab_termfont_init(void);

// Draw the terminal's visible grid at the current citro2d scene origin. Must be
// called inside a C3D frame with the top target already bound. Renders cell
// backgrounds, glyphs, and a block cursor when the view is pinned to the live
// bottom (scroll offset 0). Pure-drawing: no state mutation on `t`.
void ab_termfont_draw(const ab_term *t);

#endif // SENDAI_TERMFONT_H
