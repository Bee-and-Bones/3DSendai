import { expect, test, describe } from "bun:test";
import {
  extractSessionId,
  normalizeCodex,
} from "../src/adapters/codex/normalize.ts";
import { CodexAdapter } from "../src/adapters/codex/index.ts";
import type { AdapterEvent } from "../src/adapters/interface.ts";

describe("normalizeCodex", () => {
  test("item/agentMessage/delta -> one output event", () => {
    const events = normalizeCodex({
      method: "item/agentMessage/delta",
      params: { delta: "hi" },
    });
    expect(events).toEqual([{ kind: "output", text: "hi" }]);
  });

  test("commandExecution/requestApproval -> one high-risk approval with id", () => {
    const events = normalizeCodex({
      method: "item/commandExecution/requestApproval",
      params: { approvalId: "appr-1", command: "rm -rf /tmp/x" },
    });
    expect(events).toEqual([
      {
        kind: "approval",
        approvalId: "appr-1",
        tool: "commandExecution",
        detail: "rm -rf /tmp/x",
        risk: "high",
      },
    ]);
  });

  test("turn/completed failed -> status failed + done failed", () => {
    const events = normalizeCodex({
      method: "turn/completed",
      params: { turn: { status: "failed" } },
    });
    expect(events).toEqual([
      { kind: "status", status: "failed" },
      { kind: "done", status: "failed" },
    ]);
  });

  test("turn/completed completed -> status done + done done", () => {
    const events = normalizeCodex({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    expect(events).toEqual([
      { kind: "status", status: "done" },
      { kind: "done", status: "done" },
    ]);
  });

  test("unknown / dot-delimited method is ignored (no wrong-name matches)", () => {
    expect(normalizeCodex({ method: "thread.started", params: {} })).toEqual([]);
    expect(normalizeCodex({ method: "item.agentMessage.delta" })).toEqual([]);
    expect(normalizeCodex({ method: "turn.completed" })).toEqual([]);
  });
});

describe("extractSessionId", () => {
  test("reads sessionId from a thread/started notification", () => {
    const id = extractSessionId({
      method: "thread/started",
      params: { thread: { sessionId: "sess-42" } },
    });
    expect(id).toBe("sess-42");
  });

  test("returns undefined for other methods", () => {
    expect(
      extractSessionId({ method: "turn/completed", params: {} }),
    ).toBeUndefined();
  });
});

describe("CodexAdapter", () => {
  test("app-server mode has live approval capability", () => {
    expect(new CodexAdapter("app-server").capability.liveApproval).toBe(true);
  });

  test("exec mode is allowlist-only (no live approval)", () => {
    expect(new CodexAdapter("exec").capability.liveApproval).toBe(false);
  });

  test("feedRaw dispatches normalized events to the listener", () => {
    const adapter = new CodexAdapter("app-server");
    const seen: AdapterEvent[] = [];
    adapter.onEvent((e) => seen.push(e));
    adapter.feedRaw({ method: "item/agentMessage/delta", params: { delta: "yo" } });
    expect(seen).toEqual([{ kind: "output", text: "yo" }]);
  });

  test("resolveApproval clears a pending approval emitted via feedRaw", () => {
    const adapter = new CodexAdapter("app-server");
    const seen: AdapterEvent[] = [];
    adapter.onEvent((e) => seen.push(e));
    adapter.feedRaw({
      method: "item/fileChange/requestApproval",
      params: { approvalId: "appr-9", file: "src/x.ts" },
    });
    expect(seen).toEqual([
      {
        kind: "approval",
        approvalId: "appr-9",
        tool: "fileChange",
        detail: "src/x.ts",
        risk: "high",
      },
    ]);
    // Should not throw and should accept the decision for the emitted id.
    adapter.resolveApproval("appr-9", "allow");
  });
});
