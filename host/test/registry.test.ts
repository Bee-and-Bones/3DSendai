import { expect, test, describe } from "bun:test";
import { SessionRegistry } from "../src/registry/index.ts";
import { FakeAdapter } from "./fake-adapter.ts";
import { CAP_ALLOWLIST } from "../src/adapters/interface.ts";
import { MSG, type SessionListPayload, type SessionStatePayload } from "@agentbus/protocol";

interface Emitted {
  type: number;
  sessionId: number;
  payload: unknown;
}

function collector() {
  const frames: Emitted[] = [];
  const sink = (type: number, sessionId: number, payload: unknown) => frames.push({ type, sessionId, payload });
  const of = (type: number) => frames.filter((f) => f.type === type);
  return { frames, sink, of };
}

describe("session registry", () => {
  test("emits session_list on create and lists all sessions", () => {
    const c = collector();
    const reg = new SessionRegistry();
    reg.setSink(c.sink);
    const a = reg.create("claude", "/a", new FakeAdapter("claude"));
    const b = reg.create("codex", "/b", new FakeAdapter("codex"));
    const lastList = c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
    expect(lastList.sessions.map((s) => s.sessionId).sort()).toEqual([a, b].sort());
    expect(reg.list().find((s) => s.sessionId === a)!.agent).toBe("claude");
  });

  test("tags output frames with the correct session id", () => {
    const c = collector();
    const reg = new SessionRegistry();
    reg.setSink(c.sink);
    const a1 = new FakeAdapter("claude");
    const a2 = new FakeAdapter("codex");
    const id1 = reg.create("claude", "/a", a1);
    const id2 = reg.create("codex", "/b", a2);
    a2.emit({ kind: "output", text: "from-codex" });
    a1.emit({ kind: "output", text: "from-claude" });
    const outs = c.of(MSG.OUTPUT_CHUNK);
    expect(outs.find((f) => (f.payload as { text: string }).text === "from-codex")!.sessionId).toBe(id2);
    expect(outs.find((f) => (f.payload as { text: string }).text === "from-claude")!.sessionId).toBe(id1);
  });

  test("routes prompt and approval to the addressed session", () => {
    const reg = new SessionRegistry();
    const a1 = new FakeAdapter("claude");
    const a2 = new FakeAdapter("codex");
    const id1 = reg.create("claude", "/a", a1);
    const id2 = reg.create("codex", "/b", a2);
    reg.route(MSG.PROMPT_TEXT, id2, { text: "hi codex" });
    reg.route(MSG.APPROVAL_RESPONSE, id1, { approvalId: "x", decision: "allow" });
    expect(a2.prompts).toEqual(["hi codex"]);
    expect(a1.approvals).toEqual([{ approvalId: "x", decision: "allow" }]);
  });

  test("focus routes session-0 input to the focused session", () => {
    const reg = new SessionRegistry();
    const a1 = new FakeAdapter("claude");
    const a2 = new FakeAdapter("codex");
    reg.create("claude", "/a", a1);
    const id2 = reg.create("codex", "/b", a2);
    reg.route(MSG.FOCUS_SESSION, 0, { sessionId: id2 });
    reg.route(MSG.PROMPT_TEXT, 0, { text: "to focused" }); // session 0 => focused
    expect(a2.prompts).toEqual(["to focused"]);
    expect(a1.prompts).toEqual([]);
  });

  test("closing one session leaves the other running", () => {
    const c = collector();
    const reg = new SessionRegistry();
    reg.setSink(c.sink);
    const id1 = reg.create("claude", "/a", new FakeAdapter("claude"));
    const id2 = reg.create("codex", "/b", new FakeAdapter("codex"));
    reg.close(id1);
    expect(reg.has(id1)).toBe(false);
    expect(reg.has(id2)).toBe(true);
    const lastList = c.of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
    expect(lastList.sessions.map((s) => s.sessionId)).toEqual([id2]);
  });

  test("approval event emits approval_request and awaiting_approval state", () => {
    const c = collector();
    const reg = new SessionRegistry();
    reg.setSink(c.sink);
    const a = new FakeAdapter("claude");
    const id = reg.create("claude", "/a", a);
    a.emit({ kind: "approval", approvalId: "a1", tool: "Bash", detail: "rm x", risk: "high" });
    const req = c.of(MSG.APPROVAL_REQUEST).at(-1)!;
    expect(req.sessionId).toBe(id);
    expect((req.payload as { tool: string }).tool).toBe("Bash");
    const state = c.of(MSG.SESSION_STATE).at(-1)!.payload as SessionStatePayload;
    expect(state.status).toBe("awaiting_approval");
  });

  test("capability descriptors reflect the adapter (live vs allowlist)", () => {
    const reg = new SessionRegistry();
    reg.create("claude", "/a", new FakeAdapter("claude"));
    reg.create("codex-exec", "/b", new FakeAdapter("codex", CAP_ALLOWLIST));
    const list = reg.list();
    expect(list.find((s) => s.agent === "claude")!.capability.liveApproval).toBe(true);
    expect(list.find((s) => s.agent === "codex-exec")!.capability.liveApproval).toBe(false);
  });
});
