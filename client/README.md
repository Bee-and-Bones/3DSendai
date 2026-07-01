# ag3nt 3DS client (M1 walking-skeleton scaffold)

C/libctru homebrew that connects to the ag3nt host over WiFi (AgentBus framed
TCP), streams agent output to the top screen, and approves/denies a tool call
with A/B.

## Status: COMPILES; runtime UNVERIFIED

This **compiles cleanly** with the real devkitPro toolchain (via the Docker image
below) and produces a valid `ag3nt.3dsx` linking `citro2d`/`citro3d`/`libctru`.
It has **not been run** — that needs Citra or a real 3DS, which aren't available
here. Treat the runtime behavior as unverified and expect to iterate on-device.
Everything under `host/` and `protocol/` is built and tested.

Known simplifications a real build must address:
- JSON is hand-built/parsed with `snprintf`/`strncpy`. Vendor cJSON (as rAI3DS
  does) for correct escaping and to extract fields (`text`, `approvalId`).
- The frame payload is not NUL-terminated in place; `main.c` copies it into a
  scratch buffer before use.
- Board (M2), push-to-talk mic capture (M3), and encryption (M4) are not here yet.

## Build

```
# From client/, using the devkitPro image:
docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make
```

Set `source/config.h` (`SERVER_HOST`, `SERVER_PORT`, `PAIR_TOKEN`) to match your
host before building. `source/protocol.h` is generated from the single source of
truth in `protocol/codegen/` — run `bun run codegen` at the repo root to refresh.

## Run

Copy `ag3nt.3dsx` to your SD card (`/3ds/`) and launch via the Homebrew Launcher.

Start the host on your machine first, choosing the agent:
```
AG3NT_HOST=0.0.0.0 AG3NT_PORT=4791 AG3NT_TOKEN=ag3nt-3ds \
  AG3NT_AGENT=codex AG3NT_CWD=/path/to/repo bun run host   # or AG3NT_AGENT=claude | both
```

The client **auto-reconnects** — it survives host restarts and 3DS sleep/lid-close,
showing "reconnecting..." until the host is reachable again.

Controls: `X` = type a prompt, `A`/`B` = allow/deny an approval, `START` = quit.
