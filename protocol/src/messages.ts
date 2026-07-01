// AgentBus message payload types + version handling.
// Message type CODES live in the generated enum (single source of truth).

import { MSG, AGENTBUS_VERSION, typeName, isKnownType } from "./message-types.generated.ts";

export { MSG, AGENTBUS_VERSION, typeName, isKnownType };

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
  | "failed";

export type MacropadState = "idle" | "dictating" | "pending_approval" | "menu";

// ---- down (host -> device) payloads ----
export interface HelloPayload {
  version: number;
  server: string;
}
export interface SessionSummary {
  sessionId: number;
  agent: string;
  cwd: string;
  status: SessionStatus;
  capability: Capability;
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

/** Returns true if `payload` is a valid hello for this protocol version. */
export function isCompatibleHello(payload: unknown): payload is HelloPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as HelloPayload).version === AGENTBUS_VERSION
  );
}
