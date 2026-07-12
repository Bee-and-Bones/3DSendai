#!/bin/sh
# Package 3dsendai.elf into 3dsendai.cia. (Adapted from 3Base's tools/makeCIA.sh,
# itself vendored from 3Drop.) Needs makerom + bannertool on PATH or tools/bin --
# see bootstrapCIPackagingTools.sh.
#
# 3Drop's TMD title-version patch is intentionally dropped: that number only matters
# for over-the-wire self-update (a title overwriting its own running copy), which
# 3DSendai does not do. End-user installs (FBI/Universal Updater) ignore it.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/cia.sh"
resolveCIATools "$ROOT" || exit 1

[ -f "$ROOT/3dsendai.elf" ] || {
	echo "3dsendai.elf not found - build the client first (devkitARM make)" >&2
	exit 1
}

mkdir -p "$ROOT/build"
"$ciaBannerTool" makebanner -i "$ROOT/res/banner.png" -a "$ROOT/res/banner.wav" -o "$ROOT/build/banner.bnr" >/dev/null
"$ciaBannerTool" makesmdh -s "3DSendai" -l "Remote tmux terminal + macropad for coding agents" -p "skeletor-js" -i "$ROOT/res/icon.png" -o "$ROOT/build/icon.icn" >/dev/null
packageCIA "$ROOT/3dsendai.cia" "$ROOT/3dsendai.elf" "$ROOT/res/3dsendai.rsf" "$ROOT/build/icon.icn" "$ROOT/build/banner.bnr"

ls -la "$ROOT/3dsendai.cia"
