# syntax=docker/dockerfile:1.7
# C lint image: the pinned devkitARM base (same digest as check.yml's build3ds)
# plus the static-analysis toolchain. Reuses 3Drop's lint.Dockerfile pattern.
FROM devkitpro/devkitarm@sha256:116afba8df8453961de2936ffab20dd441edf4d682856c1ec8b0e53d7ed0bbf5

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		clang-format-14=1:14.0.6-12 \
		clang-tidy-14=1:14.0.6-12 \
		cppcheck=2.10-2 \
		shellcheck=0.9.0-1 \
		shfmt=3.6.0-1+b2 \
	&& rm -rf /var/lib/apt/lists/*
