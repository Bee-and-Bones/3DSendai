import { expect, test, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdtempSync } from "node:fs";
import { normalizeCodexExec, extractThreadId } from "../src/adapters/codex/exec-normalize.ts";
import { CodexExecAdapter } from "../src/adapters/codex/exec-driver.ts";
import type { AdapterEvent } from "../src/adapters/interface.ts";

describe("codex exec normalizer (real event shapes)", () => {
  test("turn.started -> thinking", () => {
    expect(normalizeCodexExec({ type: "turn.started" })).toEqual([{ kind: "status", status: "thinking" }]);
  });
  test("item.completed agent_message -> output", () => {
    const ev = { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hello-from-codex" } };
    expect(normalizeCodexExec(ev)).toEqual([{ kind: "output", text: "hello-from-codex" }]);
  });
  test("command_execution item -> running_tool status", () => {
    expect(normalizeCodexExec({ type: "item.completed", item: { type: "command_execution" } })).toEqual([
      { kind: "status", status: "running_tool" },
    ]);
  });
  test("turn.completed -> done", () => {
    expect(normalizeCodexExec({ type: "turn.completed", usage: {} })).toEqual([
      { kind: "status", status: "done" },
      { kind: "done", status: "done" },
    ]);
  });
  test("turn.failed -> error + done(failed)", () => {
    const out = normalizeCodexExec({ type: "turn.failed", error: "boom" });
    expect(out).toContainEqual({ kind: "done", status: "failed" });
    expect(out.find((e) => e.kind === "error")).toBeTruthy();
  });
  test("thread.started yields no adapter events but exposes the thread id", () => {
    const ev = { type: "thread.started", thread_id: "t-123" };
    expect(normalizeCodexExec(ev)).toEqual([]);
    expect(extractThreadId(ev)).toBe("t-123");
  });
});

describe("CodexExecAdapter (stub codex, hermetic)", () => {
  test("spawns codex, streams output, completes, and resumes by thread id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "3dsendai-adapter-"));
    const argsLog = `${dir}/codex-stub-args.log`;
    const stub = `${dir}/codex-stub.sh`;
    await Bun.write(argsLog, "");
    await Bun.write(
      stub,
      `#!/bin/sh
echo "$@" >> "${argsLog}"
printf '%s\\n' '{"type":"thread.started","thread_id":"t-123"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello-from-codex"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`,
    );
    chmodSync(stub, 0o755);

    const events: AdapterEvent[] = [];
    const adapter = new CodexExecAdapter({ cwd: dir, codexPath: stub, sandbox: "read-only" });
    adapter.onEvent((e) => events.push(e));

    await adapter.prompt("say hello");
    expect(events).toContainEqual({ kind: "output", text: "hello-from-codex" });
    expect(events).toContainEqual({ kind: "done", status: "done" });

    // Second prompt should resume the captured thread id.
    await adapter.prompt("again");
    const log = await Bun.file(argsLog).text();
    const lines = log.trim().split("\n");
    expect(lines[0]).not.toContain("resume");
    expect(lines[1]).toContain("resume");
    expect(lines[1]).toContain("t-123");
  });
});
