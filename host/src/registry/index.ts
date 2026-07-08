// N-session registry (U7, R6, R15). Keyed sessions multiplexed over one
// connection; the registry maps normalized AdapterEvents to AgentBus frames,
// tags them with the session id, records them for replay, and forwards them to
// a sink (a connection). session_list drives the board.

import {
	encodeFrame,
	MAX_SECURE_PLAINTEXT,
	MSG,
	type SessionStatus,
	type SessionSummary,
} from "@agentbus/protocol";
import type { Adapter, AdapterEvent, ApprovalDecision } from "../adapters/interface.ts";
import { classifyAction, decide, defaultPolicy, type Policy } from "../policy/index.ts";
import { DurableBuffer, type ReplayResult } from "./durable.ts";

export type FrameSink = (type: number, sessionId: number, payload: unknown) => void;

// U10 (plan-004): approval routing options. Escalated approvals are parked
// until the device answers; an unanswered approval denies after the timeout
// (fail-safe default). Timer functions are injectable for deterministic tests.
export interface RegistryOptions {
	policy?: Policy;
	approvalTimeoutMs?: number;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (id: unknown) => void;
}

const APPROVAL_TIMEOUT_MS = 120_000;

// A single AgentBus frame must fit the 3DS receive buffer — under encryption
// that means the sealed record can't exceed MAX_SECURE_PLAINTEXT, and the
// plaintext client has the same 16 KiB limit. Agent output is the only
// unbounded frame, so it's split here (transport-agnostic) before it can tear
// down a session. Recursive verify-and-split is correct for any content,
// including pathological JSON escaping. Leaves margin for the frame envelope.
const OUTPUT_TEXT_BUDGET = MAX_SECURE_PLAINTEXT - 64;

export function splitOutputText(text: string, budget: number = OUTPUT_TEXT_BUDGET): string[] {
	if (encodeFrame(MSG.OUTPUT_CHUNK, 0, { text }).length <= budget || text.length <= 1) {
		return [text];
	}
	// Split on a UTF-16 boundary that doesn't cleave a surrogate pair.
	let mid = text.length >> 1;
	if (mid > 0 && text.charCodeAt(mid) >= 0xdc00 && text.charCodeAt(mid) <= 0xdfff) mid -= 1;
	return [
		...splitOutputText(text.slice(0, mid), budget),
		...splitOutputText(text.slice(mid), budget),
	];
}

interface RegistrySession {
	id: number;
	agent: string;
	cwd: string;
	status: SessionStatus;
	adapter: Adapter;
}

export class SessionRegistry {
	private sessions = new Map<number, RegistrySession>();
	private nextId = 1;
	private focused: number | undefined;
	private sink: FrameSink | undefined;
	private buffer = new DurableBuffer();

	// U10: policy + parked approvals awaiting a device response (or timeout).
	private readonly policy: Policy;
	private readonly approvalTimeoutMs: number;
	private readonly schedule: (fn: () => void, ms: number) => unknown;
	private readonly cancel: (id: unknown) => void;
	private pending = new Map<string, { sessionId: number; timer: unknown }>();

	constructor(opts: RegistryOptions = {}) {
		this.policy = opts.policy ?? defaultPolicy();
		this.approvalTimeoutMs = opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
		this.schedule =
			opts.schedule ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				(t as { unref?: () => void }).unref?.(); // don't hold the process open
				return t;
			});
		this.cancel = opts.cancel ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
	}

	/** Where emitted frames go (typically a Connection.send). */
	setSink(sink: FrameSink | undefined): void {
		this.sink = sink;
	}

	create(agent: string, cwd: string, adapter: Adapter): number {
		const id = this.nextId++;
		const session: RegistrySession = { id, agent, cwd, status: "idle", adapter };
		this.sessions.set(id, session);
		adapter.onEvent((event) => this.handleEvent(id, event));
		if (this.focused === undefined) this.focused = id;
		this.emit(MSG.SESSION_STATE, id, this.summary(session));
		this.emitSessionList();
		return id;
	}

	close(id: number): void {
		const session = this.sessions.get(id);
		if (!session) return;
		void session.adapter.stop();
		this.sessions.delete(id);
		if (this.focused === id) this.focused = this.sessions.keys().next().value;
		this.emitSessionList();
	}

	focus(id: number): void {
		if (this.sessions.has(id)) this.focused = id;
	}

	get focusedId(): number | undefined {
		return this.focused;
	}

	list(): SessionSummary[] {
		return [...this.sessions.values()].map((s) => this.summary(s));
	}

	has(id: number): boolean {
		return this.sessions.has(id);
	}

	/** Route an inbound device frame to the right session. */
	route(type: number, sessionId: number, payload: unknown): void {
		if (type === MSG.FOCUS_SESSION) {
			const target = (payload as { sessionId: number }).sessionId;
			this.focus(target);
			return;
		}
		const target = sessionId || this.focused;
		if (target === undefined) return;
		const session = this.sessions.get(target);
		if (!session) return;

		switch (type) {
			case MSG.PROMPT_TEXT:
				void session.adapter.prompt((payload as { text: string }).text);
				break;
			case MSG.APPROVAL_RESPONSE: {
				const p = payload as { approvalId: string; decision: ApprovalDecision };
				// U10: un-park (cancel the timeout) before forwarding. Responses for
				// approvals we never parked still forward — the adapter is the
				// authority on which ids exist.
				const parked = this.pending.get(p.approvalId);
				if (parked) {
					this.cancel(parked.timer);
					this.pending.delete(p.approvalId);
				}
				session.adapter.resolveApproval(p.approvalId, p.decision);
				break;
			}
			case MSG.INTERRUPT:
				session.adapter.interrupt();
				break;
		}
	}

	/** Replay everything after a cursor (reconnect). */
	replay(cursor: number): ReplayResult {
		return this.buffer.replaySince(cursor);
	}

	private handleEvent(id: number, event: AdapterEvent): void {
		const session = this.sessions.get(id);
		if (!session) return;
		switch (event.kind) {
			case "output":
				for (const chunk of splitOutputText(event.text)) {
					this.emit(MSG.OUTPUT_CHUNK, id, { text: chunk });
				}
				break;
			case "status":
				session.status = event.status;
				this.emit(MSG.SESSION_STATE, id, this.summary(session));
				break;
			case "approval": {
				// U10: consult the policy before bothering the device. Positively
				// low-risk-and-allowed actions auto-approve; unaskable risky actions
				// block; everything else escalates to the device, parked until an
				// APPROVAL_RESPONSE or the fail-safe timeout deny.
				const decision = decide(
					this.policy,
					classifyAction(event.tool, event.detail, session.cwd),
					{
						liveApproval: session.adapter.capability.liveApproval,
					},
				);
				if (decision === "auto_approve") {
					session.adapter.resolveApproval(event.approvalId, "allow");
					break;
				}
				if (decision === "blocked") {
					session.adapter.resolveApproval(event.approvalId, "deny");
					this.emit(MSG.ERROR, id, {
						message: `blocked by policy: ${event.tool} (${event.detail})`,
					});
					break;
				}
				session.status = "awaiting_approval";
				this.emit(MSG.APPROVAL_REQUEST, id, {
					approvalId: event.approvalId,
					tool: event.tool,
					detail: event.detail,
					risk: event.risk,
				});
				this.emit(MSG.SESSION_STATE, id, this.summary(session));
				const timer = this.schedule(() => {
					if (!this.pending.delete(event.approvalId)) return; // already answered
					session.adapter.resolveApproval(event.approvalId, "deny");
					this.emit(MSG.ERROR, id, { message: `approval ${event.approvalId} timed out: denied` });
				}, this.approvalTimeoutMs);
				this.pending.set(event.approvalId, { sessionId: id, timer });
				break;
			}
			case "error":
				this.emit(MSG.ERROR, id, { message: event.message });
				break;
			case "done":
				session.status = event.status;
				this.emit(MSG.SESSION_STATE, id, this.summary(session));
				break;
		}
	}

	private emit(type: number, sessionId: number, payload: unknown): void {
		this.buffer.record(type, sessionId, payload);
		this.sink?.(type, sessionId, payload);
	}

	private emitSessionList(): void {
		this.emit(MSG.SESSION_LIST, 0, { sessions: this.list() });
	}

	private summary(s: RegistrySession): SessionSummary {
		return {
			sessionId: s.id,
			agent: s.agent,
			cwd: s.cwd,
			status: s.status,
			capability: s.adapter.capability,
		};
	}
}
