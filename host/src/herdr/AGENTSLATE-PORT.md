# Ported semantics: AgentSlate

3DSendai's herdr agent-supervision layer ports the **semantics** of
[AgentSlate](https://github.com/DanielOu1208/agentslate) — its herdr API usage
and its watched-screen supervision model — onto our existing sealed AgentBus
transport, Bun/TS host, and C client. This is the lighter, semantics-port
sibling of `client/source/MONOCYPHER-VENDOR.md`: **no AgentSlate source files are
vendored.** What transferred is behavior (discovery ordering, snapshot
normalization precedence, the per-agent approval keymaps, and the blocked-first
board ordering), re-implemented against our own stack and re-validated against
captured herdr wire fixtures (`host/test/fixtures/herdr/`) per AGENTS.md
invariant #8 — never against AgentSlate's code as ground truth.

## Source

- **Repo:** https://github.com/DanielOu1208/agentslate
- **Commit studied/ported:** `810d1e6963cdda771e9bbfe71247c291ce30f0ef`
  (recorded by a shallow clone at port time; the clone was not committed).
- **Files referenced:** `src/protocol.rs` (`herdr_key`, `remote_action_keys`),
  `src/herdr.rs` (session discovery ordering, snapshot normalization),
  `src/server.rs` (the `current_agent` fresh-snapshot gate + action flow),
  `ios/AgentSlate/AppModel.swift` (blocked-first sort), `docs/*` (approval
  research).

## License

AgentSlate is **MIT** (Copyright (c) 2026 Daniel Ou). MIT is permissive and
GPL-compatible, so 3DSendai (GPL-3.0) may incorporate these ported semantics;
the combined work ships under GPL-3.0. As a semantics port there are no
AgentSlate source headers to preserve — this record is the attribution.

Note on herdr itself: herdr is **AGPL-3.0** and is **not vendored**. The bridge
remains an external socket client (enumeration, snapshots, subscriptions,
`pane.send_keys`); no herdr source is copied into this repo.

## What was ported, and where

| AgentSlate concept | AgentSlate source | 3DSendai landing | Unit |
| --- | --- | --- | --- |
| Session discovery: running-only, default-first then alphabetical | `src/herdr.rs` (`session list --json` parse + sort) | `host/src/herdr/discovery.ts` | U2 |
| Snapshot normalization precedence (`kind`=`agent`, `agentName`=`display_agent ?? agent`, title/workspace fallbacks) | `src/herdr.rs` (`normalized_agents`) | `host/src/herdr/bridge.ts` (`summary`/`ensureSession`) | U4 |
| Per-kind approval key table (`remote_action_keys`) | `src/protocol.rs` | `host/src/herdr/approvals.ts` (`approvalKeys`) | U5 |
| Fresh-snapshot approval gate (present + `blocked` before sending) | `src/server.rs` (`current_agent`, the `agent_status == "blocked"` check) | `host/src/herdr/approvals.ts` (`gateApproval`) + `bridge.ts` (`handleApproval`) | U5 |
| Blocked-first dashboard ordering | `ios/AgentSlate/AppModel.swift` | `client/source/board.c` (device-side pure-C stable sort) | U6 |

**Deliberately not ported:** Tailscale transport, pairing codes (we keep PSK +
QR), 200 ms per-client polling (we keep herdr event subscriptions), on-device
speech (we keep host STT), and terminal removal (our terminal is the
differentiator). See the plan's Summary for the full not-ported list.

## Approval keymap: verification status at herdr 0.7.3

Two independent facts back each mapping, and they must not be conflated:

1. **Key-name validity** — that `y`, `n`, `esc`, `enter`, the multi-key
   `["esc","enter"]`, and `shift+tab` are accepted `pane.send_keys` inputs — was
   **capture-verified locally at herdr 0.7.3** for *all* kinds
   (`host/test/fixtures/herdr/socket-send-keys.ndjson`; U1). No `send_input
   {text}` fallback is needed.
2. **Per-agent-TUI semantics** — that a given key sequence actually
   accepts/denies *that agent's* prompt — was exercised locally only for the
   agent kinds installed during the U1 spike. The rest ship on AgentSlate's
   documented evidence (`docs/AGENT_INPUT_RESEARCH.md`), flagged below.

| kind | approve | reject | per-TUI semantics |
| --- | --- | --- | --- |
| `codex` | `["y"]` | `["n"]` | local capture (herdr 0.7.3) |
| `claude` | `["enter"]` | `["esc"]` | local capture (herdr 0.7.3) |
| `cursor` | `["y"]` | `["n"]` | AgentSlate evidence (not installed locally) |
| `omp` | `["enter"]` | `["esc"]` | AgentSlate evidence (not installed locally) |
| `opencode` | `["enter"]` | `["esc","enter"]` | AgentSlate evidence (not installed locally) |

## Accepted residual: the approval race

herdr exposes no atomic approve-iff-blocked primitive. `gateApproval` reads a
**fresh** snapshot to narrow the tap-to-snapshot window, but the window between
that snapshot and the subsequent `pane.send_keys` cannot be closed by herdr's
API. This is accepted **watched-screen** semantics: the approval is a
convenience over a screen the user is actively watching, not structured
authorization. `blocked` status is not authorization evidence (AgentSlate's own
research) — the structured `APPROVAL_REQUEST`/`APPROVAL_RESPONSE` tier stays
reserved for request-identified approvals. Documented in `approvals.ts`.
