#!/bin/sh
# Install the exact Linux packaging binaries used by GitHub Actions. Checksums
# bind each immutable input; known archive paths avoid executing an arbitrary
# same-named file if an upstream release gains more assets.
# (Vendored from 3Base's tools/bootstrapCIPackagingTools.sh, itself from 3Drop.)
set -eu

case "$(uname -s):$(uname -m)" in
Linux:x86_64) ;;
*)
	echo "bootstrapCIPackagingTools: Linux x86_64 is required" >&2
	echo "CIA packaging runs in CI; macOS/local builds produce the .3dsx/.elf only" >&2
	exit 1
	;;
esac

for requiredTool in curl sha256sum tar unzip install; do
	command -v "$requiredTool" >/dev/null 2>&1 || {
		echo "bootstrapCIPackagingTools: required tool not found: $requiredTool" >&2
		exit 1
	}
done

TOOLS_DIR="${SENDAI_CI_TOOLS_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/3dsendai-ci-tools}"
DOWNLOAD_DIR="$TOOLS_DIR/downloads"
EXTRACT_DIR="$TOOLS_DIR/extracted"
INSTALL_DIR="$TOOLS_DIR/install"
mkdir -p "$DOWNLOAD_DIR" "$EXTRACT_DIR" "$INSTALL_DIR/bin"

downloadVerified() {
	url="$1"
	destination="$2"
	expectedSHA256="$3"

	curl --location --fail --silent --show-error --output "$destination" "$url"
	printf '%s  %s\n' "$expectedSHA256" "$destination" | sha256sum --check --status || {
		echo "bootstrapCIPackagingTools: checksum failed: $destination" >&2
		exit 1
	}
}

bannertoolArchive="$DOWNLOAD_DIR/bannertool-1.2.3-linux.tar.gz"
downloadVerified \
	https://github.com/carstene1ns/3ds-bannertool/releases/download/1.2.3/bannertool-1.2.3-linux.tar.gz \
	"$bannertoolArchive" \
	748519d200519db18e9fd00c332ac32f5411e41230258291e89953a76c1f7155
rm -rf "$EXTRACT_DIR/bannertool"
mkdir -p "$EXTRACT_DIR/bannertool"
tar -xzf "$bannertoolArchive" -C "$EXTRACT_DIR/bannertool"
install -m 0755 \
	"$EXTRACT_DIR/bannertool/bannertool-1.2.3-linux/bannertool" \
	"$INSTALL_DIR/bin/bannertool"

makeromArchive="$DOWNLOAD_DIR/makerom-v0.19.0-ubuntu_x86_64.zip"
downloadVerified \
	https://github.com/3DSGuy/Project_CTR/releases/download/makerom-v0.19.0/makerom-v0.19.0-ubuntu_x86_64.zip \
	"$makeromArchive" \
	287b809dec064e0ad597e3d272c49ecb7eed41693d5ee6fef9d8a8aa24c2497e
rm -rf "$EXTRACT_DIR/makerom"
mkdir -p "$EXTRACT_DIR/makerom"
unzip -q "$makeromArchive" -d "$EXTRACT_DIR/makerom"
install -m 0755 "$EXTRACT_DIR/makerom/makerom" "$INSTALL_DIR/bin/makerom"

if [ -n "${GITHUB_PATH:-}" ]; then
	printf '%s\n' "$INSTALL_DIR/bin" >>"$GITHUB_PATH"
fi

echo "Installed CI packaging tools to $INSTALL_DIR/bin"
