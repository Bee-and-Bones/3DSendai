# Containerized 3DS homebrew build (no local devkitPro needed).
#   docker build -t ag3nt-client .
#   docker run --rm -v "$PWD":/work -w /work ag3nt-client make
# Output: ag3nt.3dsx — copy to your SD card and launch via the Homebrew Launcher.
FROM devkitpro/devkitarm:latest
WORKDIR /work
CMD ["make"]
