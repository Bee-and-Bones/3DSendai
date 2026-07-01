// Normalizer for `codex exec --json` events (the exec ThreadEvent vocabulary,
// which is DOT-delimited and item-oriented — distinct from the app-server
// slash-delimited protocol in normalize.ts). Grounded in real output from
// codex-cli 0.139.0:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{...}}
// Exec mode is allowlist/sandbox-gated: no live per-call approval.

import type { AdapterEvent } from "../interface.ts";

export interface CodexItem {
  id?: string;
  type?: string; // "agent_message" | "reasoning" | "command_execution" | "file_change" | ...
  text?: string;
}

export interface CodexExecEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: unknown;
  error?: unknown;
  message?: string;
}

export function extractThreadId(ev: CodexExecEvent): string | undefined {
  return ev.type === "thread.started" ? ev.thread_id : undefined;
}

export function normalizeCodexExec(ev: CodexExecEvent): AdapterEvent[] {
  switch (ev.type) {
    case "turn.started":
      return [{ kind: "status", status: "thinking" }];
    case "item.completed":
    case "item.updated": {
      const item = ev.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        return [{ kind: "output", text: item.text }];
      }
      if (item?.type === "command_execution" || item?.type === "file_change") {
        return [{ kind: "status", status: "running_tool" }];
      }
      return [];
    }
    case "turn.completed":
      return [
        { kind: "status", status: "done" },
        { kind: "done", status: "done" },
      ];
    case "turn.failed":
    case "error":
      return [
        { kind: "error", message: errorText(ev) },
        { kind: "done", status: "failed" },
      ];
    default:
      return []; // thread.started (handled by extractThreadId) and anything else
  }
}

function errorText(ev: CodexExecEvent): string {
  if (typeof ev.message === "string") return ev.message;
  if (typeof ev.error === "string") return ev.error;
  if (ev.error && typeof ev.error === "object") return JSON.stringify(ev.error);
  return "codex turn failed";
}
