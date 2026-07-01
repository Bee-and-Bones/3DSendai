# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## AgentBus
The single wire protocol between the 3DS client and the host: length-prefixed framed TCP, state and output flowing down to the device, semantic input events flowing up. The device speaks only AgentBus and never learns which agent it is driving.

## Host
The deployable service (Bun/TypeScript) that owns durable sessions, spawns the agent CLIs, normalizes their output into AgentBus, and serves the device. Runs on a laptop, Pi, or VPS.

## Client
The thin 3DS homebrew app (C/libctru). Draws the UI, captures input (touch, buttons, and eventually mic), and speaks AgentBus. No agent logic runs on the device.

## Adapter
A host-side component that drives one coding-agent CLI (e.g. Codex, Claude Code) and normalizes its native event stream into neutral AdapterEvents. Adding a new agent is a new adapter, not a device change.

## Session registry
The host's keyed set of concurrent agent sessions — the backing for the multi-agent board. Each session binds an agent, a working directory, and a durable output buffer, and is addressable by id.

## Capability negotiation
Per-session advertisement of what the bound agent supports (streaming, live approval, interrupt), so the device renders only the affordances that apply.

## Live-approval tier vs allowlist tier
Two approval capability classes. Live-approval agents can pause a tool call for a device approve/deny (Claude Code, Codex app-server). Allowlist-tier runs (e.g. `codex exec`) pre-authorize actions and surface out-of-policy ones as blocked.

## Macropad layout
A host-pushed, state-keyed set of bottom-screen buttons (idle, dictating, pending-approval, menu). The host decides the layout for the focused session's current state; the device just renders it.

## Push-to-talk
The planned voice input: hold a shoulder button to stream mic PCM to the host, transcribe there (the device cannot run STT), and turn the result into a prompt.
