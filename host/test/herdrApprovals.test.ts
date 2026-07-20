// U5 (plan 2026-07-20-001) Pure tests for the ported approval table + gate
// (host/src/herdr/approvals.ts). The bridge wiring (fresh snapshot -> gate ->
// pane.send_keys) is covered by route cases in herdrBridge.test.ts; here we
// pin the mapping and gate semantics in isolation.

import { describe, expect, test } from "bun:test";
import {
	type ApprovalAction,
	approvalKeys,
	gateApproval,
	hasApprovalMapping,
} from "../src/herdr/approvals.ts";

// The ten kind x action mappings, mirroring agentslate's remote_action_keys
// table test (src/protocol.rs). codex/cursor -> y/n; claude/omp -> enter/esc;
// opencode -> enter / esc+enter.
const MAPPINGS: Array<[string, ApprovalAction, string[]]> = [
	["codex", "approve", ["y"]],
	["codex", "reject", ["n"]],
	["cursor", "approve", ["y"]],
	["cursor", "reject", ["n"]],
	["claude", "approve", ["enter"]],
	["claude", "reject", ["esc"]],
	["omp", "approve", ["enter"]],
	["omp", "reject", ["esc"]],
	["opencode", "approve", ["enter"]],
	["opencode", "reject", ["esc", "enter"]],
];

describe("approvals — kind table", () => {
	for (const [kind, action, keys] of MAPPINGS) {
		test(`${kind} ${action} -> ${JSON.stringify(keys)}`, () => {
			expect(approvalKeys(kind, action)).toEqual(keys);
		});
	}

	test("an unmapped kind has no keys and no mapping", () => {
		expect(approvalKeys("gemini", "approve")).toBeUndefined();
		expect(approvalKeys("gemini", "reject")).toBeUndefined();
		expect(hasApprovalMapping("gemini")).toBe(false);
	});

	test("every allowlisted kind reports a mapping", () => {
		for (const kind of ["codex", "cursor", "claude", "omp", "opencode"]) {
			expect(hasApprovalMapping(kind)).toBe(true);
		}
	});

	test("prototype keys never resolve through the Map", () => {
		expect(hasApprovalMapping("constructor")).toBe(false);
		expect(hasApprovalMapping("__proto__")).toBe(false);
		expect(approvalKeys("toString", "approve")).toBeUndefined();
	});

	test("returned key arrays are fresh (mutating one does not corrupt the table)", () => {
		const a = approvalKeys("opencode", "reject")!;
		a.push("x");
		expect(approvalKeys("opencode", "reject")).toEqual(["esc", "enter"]);
	});
});

describe("approvals — fresh-snapshot gate", () => {
	test("blocked + mapped kind passes with the action's keys", () => {
		const g = gateApproval({ agent: "codex", agentStatus: "blocked" }, "reject");
		expect(g).toEqual({ ok: true, keys: ["n"] });
	});

	test("a missing pane is a stale agent", () => {
		expect(gateApproval(undefined, "approve")).toEqual({ ok: false, reason: "stale" });
	});

	test("a present-but-not-blocked pane is not_blocked (no keys)", () => {
		for (const status of ["working", "idle", "done", "unknown"]) {
			expect(gateApproval({ agent: "codex", agentStatus: status }, "approve")).toEqual({
				ok: false,
				reason: "not_blocked",
			});
		}
	});

	test("a blocked pane of an unmapped kind reports the kind for the ERROR", () => {
		expect(gateApproval({ agent: "gemini", agentStatus: "blocked" }, "approve")).toEqual({
			ok: false,
			reason: "unmapped",
			kind: "gemini",
		});
	});

	test("blocked-check precedes the mapping-check (an unmapped working agent is not_blocked)", () => {
		expect(gateApproval({ agent: "gemini", agentStatus: "working" }, "approve")).toEqual({
			ok: false,
			reason: "not_blocked",
		});
	});
});
