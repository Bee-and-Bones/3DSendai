---
title: "Driving coding-agent CLIs from a host: ground normalizers in real output, per mode and version"
module: host (agent adapters)
date: 2026-07-01
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - Building a host/bridge that spawns coding-agent CLIs (Claude Code, Codex, etc.) and normalizes their event streams
  - Writing an adapter that parses an agent CLI's --json / stream-json output
  - Wiring live per-call tool approval through an agent CLI
tags:
  - agent-cli
  - codex
  - claude-code
  - adapters
  - stream-json
  - integration
---

## Context

ag3nt drives coding agents from a 3DS by spawning their CLIs on a host and normalizing each agent's event stream into one neutral protocol (AgentBus). The integration surface of these CLIs is fast-moving and mode-dependent, which broke several reasonable-looking assumptions.

## Guidance

**1. Ground every normalizer in real captured output — never docs or memory.** Run the CLI once against a trivial prompt, dump the JSONL, and build the normalizer from those exact shapes. Verified 2026-07-01:

- `codex exec --json` (codex-cli 0.139.0) emits **dot-delimited ThreadEvents**: `{"type":"thread.started","thread_id":...}`, `{"type":"turn.started"}`, `{"type":"item.completed","item":{"type":"agent_message","text":...}}`, `{"type":"turn.completed"}`.
- `codex app-server` uses a **different, slash-delimited JSON-RPC** vocabulary: `thread/started`, `item/agentMessage/delta`, `turn/completed`, `item/commandExecution/requestApproval`. **The same tool, two modes, two event languages.**
- `claude -p --output-format stream-json` (Claude Code 2.1.177) emits `{"type":"system","subtype":"init","session_id":...}`, `{"type":"assistant","message":{"content":[{"type":"text","text":...},{"type":"tool_use",...}]}}`, terminal `{"type":"result","subtype":"success","is_error":...}`.

Write a small pure `normalize(event) -> AdapterEvent[]` per agent/mode and unit-test it with the captured fixtures. Keep a stub-binary test (a shell script emitting the fixture JSONL) so the spawn→parse→dispatch path is covered without spending quota.

**2. Subprocess agents do NOT inherit the interactive session's auth.** `claude -p` returned `401 authentication_failed` (`apiKeySource:none`) when spawned from a non-interactive/sandboxed shell, even though the surrounding interactive Claude session was authed. Live verification of an agent requires that CLI to be logged in **in the host process's own environment**. Design the adapter to surface an auth/early-exit as a clear error event to the client (e.g., "exited without completing the turn — check auth") instead of hanging.

**3. Hidden flags exist — probe, don't assume.** Claude Code 2.1.177's `--permission-prompt-tool` (the CLI path to live per-call approval via an MCP endpoint the CLI calls mid-turn) is **not in `--help`** but is still accepted. Test flag acceptance directly rather than concluding from `--help`.

**4. Live approval only fires mid-turn.** You cannot verify a `--permission-prompt-tool` / `app-server requestApproval` round-trip without a successful API turn. In an unauthed environment, scope live-approval as build-and-hermetically-test, and verify the round-trip only where the agent is authed.

## Why This Matters

Guessing event names from docs or an older version ships an adapter that matches zero events — the tile appears permanently stuck with no error. Assuming inherited auth makes "it hangs" look like a bug in your transport when it is the agent CLI failing to authenticate. Both waste hours; both are avoided by capturing real output and treating each CLI's mode+version as the source of truth.

## When to Apply

Any time you spawn an external agent/tool CLI and parse its structured output, especially across multiple agents or CLI versions.

## Related pattern — keep a hand-mirrored cross-language protocol in sync

The 3DS client mirrors the AgentBus protocol in hand-written C while the host uses TypeScript. To stop the two from drifting: define the message-type enum in **one source of truth** and generate both the TS enum and the C header from it (fail a CI/test check on drift), and commit **byte-exact golden wire vectors** that both the TS codec and a C harness must encode/decode identically. Drift then fails a test instead of surfacing as a garbled frame on-device.
