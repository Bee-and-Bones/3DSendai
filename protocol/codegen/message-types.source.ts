// SINGLE SOURCE OF TRUTH for AgentBus message type codes.
//
// Both the TypeScript enum (src/message-types.generated.ts) and the C client
// header (client/source/protocol.h) are generated from this list by
// codegen/generate.ts. A CI/test check regenerates and fails on drift.
//
// STABILITY RULE: values are assigned once and NEVER renumbered. New message
// types take the next unused value. Deleting a type leaves a gap. This is the
// same discipline the plan applies to U-IDs.

export interface MessageTypeDef {
  name: string;
  value: number;
  dir: "down" | "up";
  doc: string;
}

export const AGENTBUS_VERSION = 1;

export const MESSAGE_TYPES: readonly MessageTypeDef[] = [
  // down: host -> device
  { name: "HELLO", value: 1, dir: "down", doc: "server greeting + protocol version + capabilities" },
  { name: "SESSION_LIST", value: 2, dir: "down", doc: "full list of sessions for the board" },
  { name: "SESSION_STATE", value: 3, dir: "down", doc: "one session's state + capability descriptor" },
  { name: "OUTPUT_CHUNK", value: 4, dir: "down", doc: "streamed agent output for a session" },
  { name: "APPROVAL_REQUEST", value: 5, dir: "down", doc: "a pending tool call needs approve/deny" },
  { name: "TRANSCRIPT_PARTIAL", value: 6, dir: "down", doc: "streaming STT partial/final transcript" },
  { name: "MACROPAD_LAYOUT", value: 7, dir: "down", doc: "host-pushed bottom-screen layout keyed to state" },
  { name: "ERROR", value: 8, dir: "down", doc: "an error scoped to a session or the connection" },
  { name: "REPLAY_BEGIN", value: 9, dir: "down", doc: "start of a reconnect replay burst" },
  { name: "REPLAY_END", value: 10, dir: "down", doc: "end of a reconnect replay burst (carries truncation marker)" },

  // up: device -> host
  { name: "ATTACH", value: 64, dir: "up", doc: "device handshake; carries auth token + optional reconnect cursor" },
  { name: "FOCUS_SESSION", value: 65, dir: "up", doc: "device focuses a tile" },
  { name: "PROMPT_TEXT", value: 66, dir: "up", doc: "typed prompt for the focused session" },
  { name: "INPUT_EVENT", value: 67, dir: "up", doc: "generic button/touch event" },
  { name: "APPROVAL_RESPONSE", value: 68, dir: "up", doc: "allow/deny for a pending approval" },
  { name: "AUDIO_CHUNK", value: 69, dir: "up", doc: "PCM audio during push-to-talk" },
  { name: "MACRO_INTENT", value: 70, dir: "up", doc: "a macro firing as a protocol-level intent" },
  { name: "INTERRUPT", value: 71, dir: "up", doc: "interrupt the focused session" },
];
