// AgentBus message payload types + version handling.
// Message type CODES live in the generated enum (single source of truth).

import { AGENTBUS_VERSION, isKnownType, MSG, typeName } from "./message-types.generated.ts";

export { AGENTBUS_VERSION, isKnownType, MSG, typeName };

export const M1_SESSION = 0; // reserved session id for the M1 single session

// ---- Capability descriptor (R8) ----
export interface Capability {
	streaming: boolean;
	liveApproval: boolean; // true = can pause per-call (Claude canUseTool, Codex app-server)
	interrupt: boolean;
}

export type SessionStatus =
	| "idle"
	| "thinking"
	| "running_tool"
	| "awaiting_approval"
	| "blocked"
	| "done"
	| "failed"
	| "unknown"; // U3 (plan 2026-07-20-001): unrecognized backend state (herdr agent_status fallback)

export type MacropadState = "idle" | "dictating" | "pending_approval" | "menu";

// ---- down (host -> device) payloads ----
export interface HelloPayload {
	version: number;
	server: string;
}
// U3 (plan 2026-07-20-001): strictly additive agent-board enrichment fields.
// Old clients ignore unknown keys, so `agent` keeps its decorated label as the
// primary display string. Deliberately no `name` field here: the pre-refactor
// C client parses a `name` key preferentially over `agent`, and emitting one
// would collapse old-client picker labels down to a bare short name.
export interface SessionSummary {
	sessionId: number;
	agent: string;
	cwd: string;
	status: SessionStatus;
	capability: Capability;
	kind?: string; // stable agent identifier, e.g. "codex"
	agentName?: string; // short display name for the board row
	title?: string; // task title, falling back through backend title fields
	workspace?: string; // workspace label
}
export interface SessionListPayload {
	sessions: SessionSummary[];
}
export interface SessionStatePayload extends SessionSummary {}
export interface OutputChunkPayload {
	text: string;
}
export interface ApprovalRequestPayload {
	approvalId: string;
	tool: string;
	detail: string; // command / diff summary shown on the top screen
	risk: "low" | "high";
}
export interface TranscriptPartialPayload {
	text: string;
	final: boolean;
}
export interface MacropadButton {
	id: string;
	label: string;
	intent?: string;
	keys?: string; // terminal mode (U36): raw key bytes (hex) this button sends
}
export interface MacropadLayoutPayload {
	state: MacropadState;
	buttons: MacropadButton[];
}
export interface ErrorPayload {
	message: string;
}
export interface ReplayEndPayload {
	truncated: boolean;
}
// Raw tmux pane bytes for a terminal, hex-encoded (KTD4). The host chunks so a
// sealed record stays under MAX_SECURE_PLAINTEXT. `hex` decodes to the exact
// bytes the pane emitted (already un-escaped from tmux control mode).
export interface TerminalDataPayload {
	sessionId: number;
	hex: string;
}
export type AlertClass = "attention" | "session_ended" | "likely_done";
export interface AlertSignalPayload {
	sessionId: number;
	class: AlertClass;
}

// ---- up (device -> host) payloads ----
export interface AttachPayload {
	token: string;
	cursor?: number; // reconnect: replay state produced after this cursor
}
export interface FocusSessionPayload {
	sessionId: number;
}
export interface PromptTextPayload {
	text: string;
}
export interface ApprovalResponsePayload {
	approvalId: string;
	decision: "allow" | "deny";
}
export interface MacroIntentPayload {
	intent: string;
}
// Raw key bytes to inject into a session's tmux pane (hex). Printable text and
// control keys (Ctrl-C = 03, Esc = 1b, arrows = CSI sequences) alike.
export interface KeystrokePayload {
	sessionId: number;
	hex: string;
}

/** Returns true if `payload` is a valid hello for this protocol version. */
export function isCompatibleHello(payload: unknown): payload is HelloPayload {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as HelloPayload).version === AGENTBUS_VERSION
	);
}
