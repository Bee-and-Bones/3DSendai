// U33 — bundled monospace bitmap font + citro2d render helper for the terminal
// grid. COMPILES with devkitPro; runtime UNVERIFIED without hardware. This file
// MAY use citro2d — it is kept separate from the pure-C term.c so the parser
// host-compiles for the KAT.
//
// Font: an 8x8 monospace bitmap (font8x8_basic, public domain — Daniel Hepper),
// ASCII 0x20-0x7E. The system font is proportional and cannot column-align, so a
// bundled fixed-cell font is required (per the plan / DSSH reference). Cell size
// is #defined so a hardware pass (S4) can tune it.
#ifndef AG3NT_TERMFONT_H
#define AG3NT_TERMFONT_H

#include "term.h"

// Cell size in pixels. 50 cols * 8 = 400 (full top-screen width); 24 rows * 10 =
// 240 (full height). The 8x8 glyph is drawn top-left in the 8x10 cell (2px
// leading below), so descenders on g/j/p/q/y still read.
#define AB_TERMFONT_GLYPH_W 8
#define AB_TERMFONT_GLYPH_H 8
#define AB_TERMFONT_CELL_W 8
#define AB_TERMFONT_CELL_H 10

// Origin of the grid on the top screen (top-left). Full-bleed at (0,0).
#define AB_TERMFONT_ORIGIN_X 0.0f
#define AB_TERMFONT_ORIGIN_Y 0.0f

// Draw the terminal's visible grid at the current citro2d scene origin. Must be
// called inside a C3D frame with the top target already bound. Renders cell
// backgrounds, glyphs, and a block cursor when the view is pinned to the live
// bottom (scroll offset 0). Pure-drawing: no state mutation on `t`.
void ab_termfont_draw(const ab_term *t);

#endif // AG3NT_TERMFONT_H
