#!/bin/sh
# Regenerate the CIA art (res/banner.png + res/icon.png) as plain text-on-a-
# background logos. Change the two hex vars below and re-run to rebrand.
# ponytail: text-on-solid, no real artwork; swap in a designed banner/icon later.
#
# Dev-time regenerator: uses ImageMagick + a macOS system font, run locally and
# commit the PNGs (CI's makeCIA.sh consumes them, it does not regenerate).
set -eu

# --- the only two knobs -------------------------------------------------------
BG="#2D2A32" # background
FG="#F2F5FF" # text
# -----------------------------------------------------------------------------

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FONT="${LOGO_FONT:-/System/Library/Fonts/Supplemental/Arial Bold.ttf}"
MAGICK="${MAGICK:-magick}"

command -v "$MAGICK" >/dev/null 2>&1 || {
	echo "makeLogo: ImageMagick ($MAGICK) not found" >&2
	exit 1
}
[ -f "$FONT" ] || {
	echo "makeLogo: font not found: $FONT (set LOGO_FONT to override)" >&2
	exit 1
}

# banner: 256x128, "3DSendai" fit into a padded box then centered on BG.
# -depth 8 + PNG32 (8-bit RGBA): the format bannertool/makesmdh accept.
"$MAGICK" -background "$BG" -fill "$FG" -font "$FONT" \
	-size 224x88 -gravity center label:"3DSendai" \
	-gravity center -background "$BG" -extent 256x128 \
	-depth 8 "PNG32:$ROOT/res/banner.png"

# icon: 48x48, "3DS" fit into a padded box then centered on BG.
"$MAGICK" -background "$BG" -fill "$FG" -font "$FONT" \
	-size 40x34 -gravity center label:"3DS" \
	-gravity center -background "$BG" -extent 48x48 \
	-depth 8 "PNG32:$ROOT/res/icon.png"

echo "Wrote res/banner.png (256x128) + res/icon.png (48x48) — BG=$BG FG=$FG"
