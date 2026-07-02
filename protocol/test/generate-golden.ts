// Produces the checked-in byte-exact golden vectors. Run:
//   bun run protocol/test/generate-golden.ts
// A C harness must encode/decode these same bytes identically (future work);
// golden.test.ts asserts the TS codec matches them exactly.

import { encodeFrame, toHex } from "../src/frames.ts";
import { MSG, AGENTBUS_VERSION } from "../src/index.ts";

interface Vector {
  name: string;
  type: number;
  sessionId: number;
  payload: unknown;
  hex: string;
}

const cases: Array<Omit<Vector, "hex">> = [
  { name: "hello", type: MSG.HELLO, sessionId: 0, payload: { version: AGENTBUS_VERSION, server: "ag3nt" } },
  { name: "attach", type: MSG.ATTACH, sessionId: 0, payload: { token: "pair-abc123" } },
  { name: "attach_reconnect", type: MSG.ATTACH, sessionId: 0, payload: { token: "pair-abc123", cursor: 42 } },
  { name: "prompt_text", type: MSG.PROMPT_TEXT, sessionId: 0, payload: { text: "add a null check" } },
  { name: "output_chunk", type: MSG.OUTPUT_CHUNK, sessionId: 7, payload: { text: "hello" } },
  {
    name: "approval_request",
    type: MSG.APPROVAL_REQUEST,
    sessionId: 3,
    payload: { approvalId: "a1", tool: "Bash", detail: "rm -rf build", risk: "high" },
  },
  { name: "approval_response", type: MSG.APPROVAL_RESPONSE, sessionId: 3, payload: { approvalId: "a1", decision: "deny" } },
  {
    name: "session_state",
    type: MSG.SESSION_STATE,
    sessionId: 2,
    payload: {
      sessionId: 2,
      agent: "codex",
      cwd: "/repo",
      status: "awaiting_approval",
      capability: { streaming: true, liveApproval: true, interrupt: true },
    },
  },
  {
    name: "macropad_layout",
    type: MSG.MACROPAD_LAYOUT,
    sessionId: 2,
    payload: { state: "pending_approval", buttons: [{ id: "a", label: "Allow" }, { id: "b", label: "Deny" }] },
  },
  // plan-003: terminal-mode frames (U30)
  { name: "terminal_data", type: MSG.TERMINAL_DATA, sessionId: 4, payload: { sessionId: 4, hex: "1b5b33326d6f6b1b5b306d" } },
  { name: "alert_signal", type: MSG.ALERT_SIGNAL, sessionId: 4, payload: { sessionId: 4, class: "attention" } },
  { name: "keystroke", type: MSG.KEYSTROKE, sessionId: 4, payload: { sessionId: 4, hex: "03" } },
];

const vectors: Vector[] = cases.map((c) => ({ ...c, hex: toHex(encodeFrame(c.type, c.sessionId, c.payload)) }));

const out = new URL("./golden/vectors.json", import.meta.url).pathname;
await Bun.write(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`Wrote ${vectors.length} golden vectors to ${out}`);
