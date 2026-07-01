// Capability negotiation (U8, R8). Both Claude and Codex-via-app-server support
// live per-call approval; only the codex exec fallback and future agents are
// allowlist-only (deepening finding #4).

import type { Capability } from "@agentbus/protocol";
import { CAP_ALLOWLIST, CAP_LIVE_APPROVAL } from "../adapters/interface.ts";

export type CodexMode = "app-server" | "exec";

export function capabilityFor(agent: string, mode?: string): Capability {
  if (agent === "claude") return CAP_LIVE_APPROVAL;
  if (agent === "codex") return mode === "exec" ? CAP_ALLOWLIST : CAP_LIVE_APPROVAL;
  return CAP_ALLOWLIST; // unknown/future agents default to the allowlist tier
}
