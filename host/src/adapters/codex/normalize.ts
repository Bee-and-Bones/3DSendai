// Pure normalizer for the codex `app-server` JSON-RPC protocol (deepening #3/#4).
// The app-server speaks SLASH-delimited method names (thread/started,
// item/agentMessage/delta, turn/completed, ...), NOT the dot-delimited names
// (thread.started, item.*) that some early notes assumed. We only match the
// real names; anything else is ignored so a schema drift degrades gracefully.
//
// Kept separate from the live transport driver so it is fixture-testable in
// isolation. The authoritative schema should be regenerated via
// `codex app-server generate-ts` and pinned; these types are the hand-written
// subset the host actually consumes.

import type { AdapterEvent } from "../interface.ts";

/** A raw JSON-RPC notification from `codex app-server` (params shape varies). */
export type CodexRaw = { method: string; params?: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** Both command-execution and file-change approvals normalize the same way. */
function normalizeApproval(params: unknown, tool: string): AdapterEvent[] {
	const p = asRecord(params);
	if (!p) return [];
	const approvalId = typeof p.approvalId === "string" ? p.approvalId : undefined;
	if (!approvalId) return [];
	const detail =
		typeof p.command === "string"
			? p.command
			: typeof p.file === "string"
				? p.file
				: typeof p.detail === "string"
					? p.detail
					: "";
	return [{ kind: "approval", approvalId, tool, detail, risk: "high" }];
}

/** Raw codex app-server notification -> zero or more AdapterEvents. */
export function normalizeCodex(raw: CodexRaw): AdapterEvent[] {
	switch (raw.method) {
		case "item/agentMessage/delta": {
			const p = asRecord(raw.params);
			const delta = p && typeof p.delta === "string" ? p.delta : undefined;
			return delta === undefined ? [] : [{ kind: "output", text: delta }];
		}
		case "item/commandExecution/requestApproval":
			return normalizeApproval(raw.params, "commandExecution");
		case "item/fileChange/requestApproval":
			return normalizeApproval(raw.params, "fileChange");
		case "turn/completed": {
			const p = asRecord(raw.params);
			const turn = p ? asRecord(p.turn) : undefined;
			const status = turn && typeof turn.status === "string" ? turn.status : undefined;
			if (status === "completed") {
				return [
					{ kind: "status", status: "done" },
					{ kind: "done", status: "done" },
				];
			}
			// "interrupted" | "failed" (or anything non-completed) -> failed.
			return [
				{ kind: "status", status: "failed" },
				{ kind: "done", status: "failed" },
			];
		}
		default:
			return [];
	}
}

/** Read `thread.sessionId` from a `thread/started` notification, if present. */
export function extractSessionId(raw: CodexRaw): string | undefined {
	if (raw.method !== "thread/started") return undefined;
	const p = asRecord(raw.params);
	const thread = p ? asRecord(p.thread) : undefined;
	const sessionId = thread ? thread.sessionId : undefined;
	return typeof sessionId === "string" ? sessionId : undefined;
}
