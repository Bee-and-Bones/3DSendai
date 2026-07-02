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

// Secure-transport + discovery wire constants. Single-sourced here so the TS
// codec (protocol/src/crypto-constants.generated.ts) and the C client
// (client/source/protocol.h) can never drift. XChaCha20-Poly1305 AEAD wraps
// each AgentBus frame; the AAD binds context, direction, epoch, and sequence.
// Added for U23 (encrypted transport). Values are facts, not preferences.

export interface WireConstant {
  name: string;
  value: number | string;
  doc: string;
}

export const CRYPTO_CONSTANTS: readonly WireConstant[] = [
  { name: "KEY_BYTES", value: 32, doc: "XChaCha20-Poly1305 pre-shared key length" },
  { name: "NONCE_BYTES", value: 24, doc: "per-frame random nonce (192-bit, random-safe)" },
  { name: "MAC_BYTES", value: 16, doc: "Poly1305 authentication tag" },
  { name: "MAX_RECORD_BYTES", value: 16380, doc: "max sealed record (nonce|ct|mac); == client RXBUF minus the 4-byte outer length prefix. Both ends enforce this before buffering." },
  { name: "EPOCH_BYTES", value: 8, doc: "per-connection anti-replay epoch, host-minted" },
  { name: "SEQ_BYTES", value: 8, doc: "per-direction monotonic counter (in AAD, not on wire)" },
  { name: "DIR_DOWN", value: 0, doc: "AAD direction byte: host -> device" },
  { name: "DIR_UP", value: 1, doc: "AAD direction byte: device -> host" },
  { name: "CHALLENGE_BYTES", value: 8, doc: "discovery probe random challenge" },
  { name: "DISCOVERY_PROBE", value: 1, doc: "discovery datagram TYPE: device -> host probe" },
  { name: "DISCOVERY_REPLY", value: 2, doc: "discovery datagram TYPE: host -> device reply" },
  { name: "DEFAULT_TCP_PORT", value: 4791, doc: "AgentBus TCP port (host listens)" },
  { name: "DEFAULT_DISCOVERY_PORT", value: 41337, doc: "UDP discovery port (host responder)" },
];

// String constants kept separate so the C emitter renders them as string
// literals. AAD context strings provide domain separation between the TCP
// transport and discovery datagrams so a captured frame can't be spliced
// across channels.
export const CRYPTO_STRINGS: readonly WireConstant[] = [
  { name: "AAD_MSG_CONTEXT", value: "3dsendai-msg-v1", doc: "AAD domain tag for TCP frames" },
  { name: "AAD_DSC_CONTEXT", value: "3dsendai-dsc-v1", doc: "AAD domain tag for discovery datagrams" },
  { name: "DISCOVERY_MAGIC", value: "ag3n", doc: "discovery datagram magic prefix" },
];

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
  { name: "TERMINAL_DATA", value: 11, dir: "down", doc: "raw tmux pane bytes (hex) for a session's terminal (U30/plan-003)" },
  { name: "ALERT_SIGNAL", value: 12, dir: "down", doc: "attention event class for sound/LED (bell, session ended, likely done)" },

  // up: device -> host
  { name: "ATTACH", value: 64, dir: "up", doc: "device handshake; carries auth token + optional reconnect cursor" },
  { name: "FOCUS_SESSION", value: 65, dir: "up", doc: "device focuses a tile" },
  { name: "PROMPT_TEXT", value: 66, dir: "up", doc: "typed prompt for the focused session" },
  { name: "INPUT_EVENT", value: 67, dir: "up", doc: "generic button/touch event" },
  { name: "APPROVAL_RESPONSE", value: 68, dir: "up", doc: "allow/deny for a pending approval" },
  { name: "AUDIO_CHUNK", value: 69, dir: "up", doc: "PCM audio during push-to-talk" },
  { name: "MACRO_INTENT", value: 70, dir: "up", doc: "a macro firing as a protocol-level intent" },
  { name: "INTERRUPT", value: 71, dir: "up", doc: "interrupt the focused session" },
  { name: "KEYSTROKE", value: 72, dir: "up", doc: "raw key bytes (hex) to inject into a session's tmux pane (U30/plan-003)" },
];
