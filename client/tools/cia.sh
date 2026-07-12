#!/bin/sh
# Shared CIA packaging, sourced by makeCIA.sh. (Vendored from 3Base's tools/cia.sh,
# itself vendored from 3Drop.)

# Resolve bannertool + makerom: env override, then PATH, then tools/bin. Names are
# prefixed because POSIX shell variables are global when this library is sourced.
resolveCIATools() {
	ciaRoot="$1"
	ciaBannerTool="${BANNERTOOL:-}"
	if [ -z "$ciaBannerTool" ]; then
		command -v bannertool >/dev/null 2>&1 && ciaBannerTool="$(command -v bannertool)" || ciaBannerTool="$ciaRoot/tools/bin/bannertool"
	fi
	ciaMakeRom="${MAKEROM:-}"
	if [ -z "$ciaMakeRom" ]; then
		command -v makerom >/dev/null 2>&1 && ciaMakeRom="$(command -v makerom)" || ciaMakeRom="$ciaRoot/tools/bin/makerom"
	fi
	[ -x "$ciaBannerTool" ] || {
		echo "bannertool not found or not executable: $ciaBannerTool" >&2
		echo "run tools/bootstrapCIPackagingTools.sh first (Linux x86_64; CIA packaging is CI/Linux)" >&2
		return 1
	}
	[ -x "$ciaMakeRom" ] || {
		echo "makerom not found or not executable: $ciaMakeRom" >&2
		echo "run tools/bootstrapCIPackagingTools.sh first (Linux x86_64; CIA packaging is CI/Linux)" >&2
		return 1
	}
}

# packageCIA <out.cia> <elf> <rsf> <icon.icn> <banner.bnr>
# Build one CIA with the standard makerom flags (test-signed homebrew SD app).
packageCIA() {
	"$ciaMakeRom" -f cia -o "$1" -elf "$2" -rsf "$3" -icon "$4" -banner "$5" -exefslogo -target t
}
