# Containerized 3DS homebrew build (no local devkitPro needed).
#   docker build -t 3dsendai-client .
#   docker run --rm -v "$PWD":/work -w /work 3dsendai-client make
# Output: 3dsendai.3dsx — copy to your SD card and launch via the Homebrew Launcher.
FROM devkitpro/devkitarm:latest
WORKDIR /work
CMD ["make"]
