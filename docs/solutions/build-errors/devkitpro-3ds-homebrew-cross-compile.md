---
title: devkitPro 3DS homebrew builds — compile early, and set LD for C-only projects
module: client (3DS homebrew)
date: 2026-07-01
problem_type: build_error
component: tooling
severity: medium
symptoms:
  - "linking failed: ld unrecognised emulation mode: float-abi=hard (host aarch64 ld invoked instead of the ARM toolchain)"
  - "implicit declaration of function 'fcntl' / 'F_SETFL' undeclared in a file using sockets"
  - "a hand-written .3dsx Makefile compiles objects but fails at the link step"
root_cause: config_error
resolution_type: config_change
tags:
  - devkitpro
  - 3ds
  - homebrew
  - cross-compile
  - makefile
  - libctru
---

## Problem

Hand-written C + Makefile for a Nintendo 3DS homebrew client (`.3dsx`) looked correct but only revealed three real bugs once actually compiled with the devkitPro toolchain. None were catchable by reading the code.

## Symptoms

- Link step failed with `ld: unrecognised emulation mode: float-abi=hard` (and `tp=soft`) — the message is from the **host `aarch64` ld**, not the ARM linker.
- `implicit declaration of function 'fcntl'`, `'F_SETFL' undeclared`, `'O_NONBLOCK' undeclared` in the socket file.
- Objects compiled fine; failure was isolated to linking.

## What Didn't Work

- Trusting the scaffold because it "looked right." A 3DS client cannot be validated by inspection — the toolchain surfaces issues (header availability, linker selection, arch flags) that are invisible until `make` runs.
- Copying arch flags loosely: an invented `-mtp=soft` in `ARCH` broke the link (it is not a valid flag to pass through to the linker driver here).

## Solution

Build in the real toolchain via Docker (no local devkitPro needed):

```sh
docker run --rm -v "$PWD/client":/work -w /work devkitpro/devkitarm:latest make
```

Three fixes:

1. **Set `LD` for a C-only project.** The Makefile never set `LD`, so `make` defaulted to the host `ld` (aarch64), which rejected the ARM `-mfloat-abi=hard`/`-march` flags. For a C-only devkitPro project, link with the C compiler driver:

   ```makefile
   LD := $(CC)   # C++ projects use $(CXX)
   ```

2. **Include `<fcntl.h>`** in any file that calls `fcntl`/`O_NONBLOCK`. libctru's socket surface does not pull it in transitively.

3. **Use the standard ARM arch flags only** — no stray `-mtp=soft`:

   ```makefile
   ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard
   ```

## Why This Works

The devkitPro `3ds_rules` link rule invokes `$(LD)`. If the Makefile doesn't set it, GNU Make's built-in default (`ld` on PATH = the host linker) is used, which cannot target ARM. Pointing `LD` at the ARM `gcc` driver makes the driver consume the `-m*` flags and invoke the correct ARM `ld`. The missing include and the bogus arch flag are ordinary compile/link errors that only appear under the real toolchain.

## Prevention

- **Compile cross-targets early and in the real toolchain.** Do not let hand-written C/Makefiles for an unusual target (3DS, embedded, WASM) sit "scaffolded but unbuilt" — the first `make` is where the real bugs are. On a machine without the SDK, use the vendor's Docker image (`devkitpro/devkitarm`).
- On macOS, install a Docker daemon with `brew install colima docker && colima start` (no Docker Desktop needed). If pulls fail with `docker-credential-desktop ... not found`, remove the stale `credsStore` key from `~/.docker/config.json`.
- Keep a warning-free build as the bar; benign `snprintf`/`strncpy` truncation notes are acceptable on a scaffold but should be replaced with bounded copies for production.
