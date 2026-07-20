// U5 (plan 2026-07-20-001) Watched-screen approval semantics for the herdr
// bridge — the pure kind->sequence table and the fresh-snapshot gate predicate.
//
// Port provenance: `remote_action_keys` from
// https://github.com/DanielOu1208/agentslate src/protocol.rs (MIT, Daniel Ou).
// The fresh-snapshot "current_agent" gate ports src/server.rs (the
// `agent.agent_status == "blocked"` check before `remote_action_keys`). Full
// attribution + per-kind capture-verification status live in
// host/src/herdr/AGENTSLATE-PORT.md.
//
// Key-name validity: the sequences below (`y`/`n`, `esc`, `enter`, and the
// multi-key `["esc","enter"]`) are all valid `pane.send_keys` names at herdr
// 0.7.3, capture-verified in host/test/fixtures/herdr/socket-send-keys.ndjson —
// so no `send_input {text}` fallback is needed (U1 fact).
//
// Open race (accepted watched-screen semantics): herdr exposes no atomic
// approve-iff-blocked primitive. This gate reads a FRESH snapshot to narrow the
// tap-to-snapshot window, but the window between that snapshot and the
// pane.send_keys the bridge subsequently issues cannot be closed by herdr's API
// design. Approvals here are a convenience over a screen the user is watching,
// not structured authorization — `blocked` status is not authorization evidence
// (carried from agentslate's own research; the APPROVAL_REQUEST tier stays
// reserved for request-identified approvals).

/** The two watched-screen actions the device can tap on a blocked row. */
export type ApprovalAction = "approve" | "reject";

/** Per-kind accept/deny key sequences (ported verbatim from agentslate). */
interface KindKeys {
	approve: readonly string[];
	reject: readonly string[];
}

// The compiled five-kind allowlist. Kept as a Map (not a plain object) so a kind
// like "constructor" or "__proto__" can never resolve through the prototype.
const KIND_KEYS: ReadonlyMap<string, KindKeys> = new Map([
	// Codex / Cursor drive a y/n confirmation prompt.
	["codex", { approve: ["y"], reject: ["n"] }],
	["cursor", { approve: ["y"], reject: ["n"] }],
	// Claude Code / omp: Enter accepts, Esc rejects.
	["claude", { approve: ["enter"], reject: ["esc"] }],
	["omp", { approve: ["enter"], reject: ["esc"] }],
	// opencode: Enter accepts; reject is Esc then Enter (dismiss + confirm).
	["opencode", { approve: ["enter"], reject: ["esc", "enter"] }],
]);

/** True iff `kind` is in the compiled allowlist (has an approval mapping). */
export function hasApprovalMapping(kind: string): boolean {
	return KIND_KEYS.has(kind);
}

/**
 * The key sequence for `kind`+`action`, or undefined when the kind is unmapped.
 * Returns a fresh mutable array so callers can hand it straight to a request.
 */
export function approvalKeys(kind: string, action: ApprovalAction): string[] | undefined {
	const k = KIND_KEYS.get(kind);
	if (!k) return undefined;
	return [...(action === "approve" ? k.approve : k.reject)];
}

/** The minimal fresh-snapshot view of one pane the gate needs. */
export interface GatePane {
	agent: string; // herdr `agent` (== kind)
	agentStatus: string; // fresh `agent_status`
}

/** The gate outcome: `ok` carries the keys to send; failures carry a typed reason. */
export type ApprovalGate =
	| { ok: true; keys: string[] }
	| { ok: false; reason: "stale" }
	| { ok: false; reason: "not_blocked" }
	| { ok: false; reason: "unmapped"; kind: string };

/**
 * The pure approval gate (ports agentslate's server-side current_agent check):
 * the pane must still be present in the fresh snapshot (`pane` defined), be
 * `blocked`, and have a mapped kind. Any failure returns a typed reason and NO
 * keys — the bridge sends nothing on a failed gate.
 */
export function gateApproval(pane: GatePane | undefined, action: ApprovalAction): ApprovalGate {
	if (!pane) return { ok: false, reason: "stale" };
	if (pane.agentStatus !== "blocked") return { ok: false, reason: "not_blocked" };
	const keys = approvalKeys(pane.agent, action);
	if (!keys) return { ok: false, reason: "unmapped", kind: pane.agent };
	return { ok: true, keys };
}
