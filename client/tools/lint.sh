#!/bin/sh
# C static-analysis gate for the 3DS client. Runs clang-format, cppcheck, and
# clang-tidy inside the pinned lint image (reuses 3Drop's self-dockerizing
# pattern). First-party code only — vendored monocypher/quirc are excluded.
#   client/tools/lint.sh          # check (CI); fails on any finding
#   client/tools/lint.sh format   # rewrite files in place (clang-format -i)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${SENDAI_LINT_IMAGE:-3dsendai-lint:bookworm}"
MODE="${1:-${SENDAI_LINT_MODE:-check}}"

case "$MODE" in check | format) ;;
*)
	echo "usage: $0 [check|format]" >&2
	exit 2
	;;
esac

if [ "${SENDAI_LINT_INSIDE:-0}" != 1 ]; then
	docker build --quiet --file "$ROOT/tools/lint.Dockerfile" --tag "$IMAGE" \
		"$ROOT/tools" >/dev/null
	exec docker run --rm \
		--user "$(id -u):$(id -g)" \
		--env HOME=/tmp \
		--env SENDAI_LINT_INSIDE=1 \
		--env SENDAI_LINT_MODE="$MODE" \
		--volume "$ROOT:/work" \
		--workdir /work \
		"$IMAGE" tools/lint.sh
fi

cd "$ROOT"

# First-party, hand-written C: everything under source/ except the vendored
# crypto/QR libs and the codegen-owned protocol.h (the drift gate owns its shape).
firstParty="$(find source -maxdepth 1 -type f \( -name '*.c' -o -name '*.h' \) |
	grep -vE '/(monocypher|quirc)\.[ch]$|/protocol\.h$' | sort)"
firstPartyC="$(printf '%s\n' "$firstParty" | grep '\.c$' || true)"

if [ "$MODE" = format ]; then
	# shellcheck disable=SC2086
	printf '%s\n' $firstParty | xargs clang-format-14 -i
	shfmt -w -i 0 tools/*.sh
	exit 0
fi

# shellcheck disable=SC2086
printf '%s\n' $firstParty | xargs clang-format-14 --dry-run --Werror

# shellcheck disable=SC2086
cppcheck --enable=warning,style,performance,portability --error-exitcode=1 \
	--suppress=missingIncludeSystem --inline-suppr \
	--suppress='*:source/monocypher.h' --suppress='*:source/quirc.h' \
	-I source $firstPartyC

ARM_GCC=/opt/devkitpro/devkitARM/bin/arm-none-eabi-gcc
gccInclude="$("$ARM_GCC" -print-file-name=include)"
sysroot="$("$ARM_GCC" -print-sysroot)"
# shellcheck disable=SC2086
clang-tidy-14 --quiet $firstParty -- \
	--target=arm-none-eabi \
	-x c \
	-std=gnu11 \
	-D__3DS__ \
	-I/work/source \
	-I/opt/devkitpro/libctru/include \
	-isystem "$sysroot/include" \
	-isystem "$gccInclude"

shellcheck tools/*.sh
shfmt -d -i 0 tools/*.sh
