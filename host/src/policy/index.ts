// Per-repo approval policy + escalation (U12, deepening finding #12
// "fail-safe not fail-open"). `decide` never auto-approves anything it can't
// positively classify as low-risk-and-allowed: unknown or risky actions
// escalate to a human when the agent supports live approval, and are blocked
// outright for allowlist-only agents that have no one to ask.

import { classifyAction, type ActionClass, type Classification } from "./classify.ts";

export { classifyAction };
export type { ActionClass, Classification };

export type PolicyDecision = "auto_approve" | "escalate" | "blocked";

/** A per-repo policy loaded from JSON. Both fields hold action-class names. */
export interface Policy {
  /** Classes that may be auto-approved when their risk is low. */
  autoApprove: ActionClass[];
  /** Classes that must always be escalated (never auto-approved). */
  alwaysAsk: ActionClass[];
}

/**
 * Conservative default when no per-repo policy is configured: auto-approve only
 * low-risk reads; everything else is asked or blocked.
 */
export function defaultPolicy(): Policy {
  return { autoApprove: ["read"], alwaysAsk: ["shell", "network", "delete"] };
}

export interface DecideOptions {
  /** Whether the agent can prompt a human live (vs. allowlist-only). */
  liveApproval: boolean;
}

/** Fail-safe fallback: escalate if we can ask a human, otherwise block. */
function fallback(opts: DecideOptions): PolicyDecision {
  return opts.liveApproval ? "escalate" : "blocked";
}

export function decide(
  policy: Policy,
  action: Classification,
  opts: DecideOptions,
): PolicyDecision {
  // Explicit always-ask wins, and unknown always fails safe.
  if (action.class === "unknown" || policy.alwaysAsk.includes(action.class)) {
    return fallback(opts);
  }
  // Only a positively-allowed, low-risk action is auto-approved.
  if (policy.autoApprove.includes(action.class) && action.risk === "low") {
    return "auto_approve";
  }
  return fallback(opts);
}
