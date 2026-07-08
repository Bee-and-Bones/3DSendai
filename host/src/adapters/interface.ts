// The adapter contract (U4). Every agent adapter normalizes its CLI's native
// event stream into AgentBus-neutral AdapterEvents and accepts approval
// decisions the same way, so the registry/server never learn a CLI exists.
// This is the seam that makes R9 ("add-agent = host adapter") true.

import type { Capability, SessionStatus } from "@agentbus/protocol";

export type { Capability, SessionStatus };

/** A normalized event, already in AgentBus terms. */
export type AdapterEvent =
	| { kind: "output"; text: string }
	| { kind: "status"; status: SessionStatus }
	| {
			kind: "approval";
			approvalId: string;
			tool: string;
			detail: string;
			risk: "low" | "high";
	  }
	| { kind: "error"; message: string }
	| { kind: "done"; status: "done" | "failed" };

/** Decision handed back for a previously-emitted approval event. */
export type ApprovalDecision = "allow" | "deny";

/**
 * A pure normalizer: raw CLI event -> zero or more AdapterEvents.
 * This is the unit-testable core of every adapter (fixture-driven), separate
 * from the live process/transport driver.
 */
export type Normalizer<Raw> = (raw: Raw) => AdapterEvent[];

export type AdapterEventListener = (event: AdapterEvent) => void;

/** The live adapter a session binds to. Backed by a real CLI process/transport. */
export interface Adapter {
	readonly agent: string;
	readonly capability: Capability;
	/** Register the normalized-event listener (push model; registry subscribes). */
	onEvent(listener: AdapterEventListener): void;
	/** Send a prompt to the agent. */
	prompt(text: string): Promise<void>;
	/** Resolve a pending approval the adapter previously emitted. */
	resolveApproval(approvalId: string, decision: ApprovalDecision): void;
	/** Interrupt the current turn. */
	interrupt(): void;
	/** Tear down the underlying process/transport. */
	stop(): Promise<void>;
}

export const CAP_LIVE_APPROVAL: Capability = {
	streaming: true,
	liveApproval: true,
	interrupt: true,
};

export const CAP_ALLOWLIST: Capability = {
	streaming: true,
	liveApproval: false,
	interrupt: false,
};
