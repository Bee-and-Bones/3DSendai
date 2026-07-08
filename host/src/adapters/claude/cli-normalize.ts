// Normalizer for `claude -p --output-format stream-json` events (Claude Code
// CLI, NOT the Agent SDK). Grounded in real envelope shapes from claude 2.1.177:
//   {"type":"system","subtype":"init","session_id":"...","tools":[...]}
//   {"type":"system","subtype":"api_retry","error":"authentication_failed",...}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
//   {"type":"result","subtype":"success","is_error":false,"result":"..."}
// The assistant message content array carries text blocks (output) and tool_use
// blocks (tool activity). result is terminal; is_error marks failure (e.g. auth).

import type { AdapterEvent } from "../interface.ts";

export interface ClaudeContentBlock {
	type?: string; // "text" | "tool_use" | ...
	text?: string;
	name?: string; // tool name for tool_use
}

export interface ClaudeCliEvent {
	type?: string; // "system" | "assistant" | "user" | "result" | "stream_event"
	subtype?: string; // for system: "init" | "api_retry" | ...
	session_id?: string;
	message?: { content?: ClaudeContentBlock[] };
	result?: string;
	is_error?: boolean;
}

export function extractClaudeSessionId(ev: ClaudeCliEvent): string | undefined {
	return ev.type === "system" && ev.subtype === "init" ? ev.session_id : undefined;
}

export function normalizeClaudeCli(ev: ClaudeCliEvent): AdapterEvent[] {
	if (ev.type === "assistant") {
		const out: AdapterEvent[] = [];
		for (const block of ev.message?.content ?? []) {
			if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				out.push({ kind: "output", text: block.text });
			} else if (block.type === "tool_use") {
				out.push({ kind: "status", status: "running_tool" });
			}
		}
		return out;
	}
	if (ev.type === "result") {
		if (ev.is_error) {
			return [
				{ kind: "error", message: ev.result ?? "claude reported an error" },
				{ kind: "done", status: "failed" },
			];
		}
		return [
			{ kind: "status", status: "done" },
			{ kind: "done", status: "done" },
		];
	}
	// system/init, api_retry, hooks, user tool_result echoes, stream_event → ignore
	return [];
}
