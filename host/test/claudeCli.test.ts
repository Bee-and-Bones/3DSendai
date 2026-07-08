import { expect, test, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdtempSync } from "node:fs";
import { normalizeClaudeCli, extractClaudeSessionId } from "../src/adapters/claude/cliNormalize.ts";
import { ClaudeCliAdapter } from "../src/adapters/claude/cliDriver.ts";
import type { AdapterEvent } from "../src/adapters/interface.ts";

describe("claude CLI normalizer (real envelope shapes)", () => {
  test("assistant text block -> output", () => {
    const ev = { type: "assistant", message: { content: [{ type: "text", text: "hello-from-claude" }] } };
    expect(normalizeClaudeCli(ev)).toEqual([{ kind: "output", text: "hello-from-claude" }]);
  });
  test("assistant tool_use block -> running_tool status", () => {
    const ev = { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } };
    expect(normalizeClaudeCli(ev)).toEqual([{ kind: "status", status: "running_tool" }]);
  });
  test("result success -> done", () => {
    expect(normalizeClaudeCli({ type: "result", subtype: "success", is_error: false, result: "done" })).toEqual([
      { kind: "status", status: "done" },
      { kind: "done", status: "done" },
    ]);
  });
  test("result is_error (e.g. auth) -> error + done(failed)", () => {
    const out = normalizeClaudeCli({ type: "result", is_error: true, result: "Failed to authenticate" });
    expect(out).toContainEqual({ kind: "done", status: "failed" });
    expect(out.find((e) => e.kind === "error")).toMatchObject({ message: "Failed to authenticate" });
  });
  test("system/init yields no events but exposes the session id", () => {
    const ev = { type: "system", subtype: "init", session_id: "s-123" };
    expect(normalizeClaudeCli(ev)).toEqual([]);
    expect(extractClaudeSessionId(ev)).toBe("s-123");
  });
  test("api_retry and hooks are ignored", () => {
    expect(normalizeClaudeCli({ type: "system", subtype: "api_retry", is_error: false })).toEqual([]);
  });
});

describe("ClaudeCliAdapter (stub claude, hermetic)", () => {
  test("spawns claude, streams output, completes, and resumes by session id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "3dsendai-adapter-"));
    const argsLog = `${dir}/claude-stub-args.log`;
    const stub = `${dir}/claude-stub.sh`;
    await Bun.write(argsLog, "");
    await Bun.write(
      stub,
      `#!/bin/sh
echo "$@" >> "${argsLog}"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s-123"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"hello-from-claude"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"hello-from-claude"}'
`,
    );
    chmodSync(stub, 0o755);

    const events: AdapterEvent[] = [];
    const adapter = new ClaudeCliAdapter({ cwd: dir, claudePath: stub, permissionMode: "acceptEdits" });
    adapter.onEvent((e) => events.push(e));

    await adapter.prompt("say hello");
    expect(events).toContainEqual({ kind: "output", text: "hello-from-claude" });
    expect(events).toContainEqual({ kind: "done", status: "done" });

    await adapter.prompt("again");
    const lines = (await Bun.file(argsLog).text()).trim().split("\n");
    expect(lines[0]).not.toContain("--resume");
    expect(lines[1]).toContain("--resume");
    expect(lines[1]).toContain("s-123");
  });
});
