// Codex adapter. Two run modes with different capabilities (deepening #4):
//   - "app-server": drives `codex app-server` (JSON-RPC over stdio). This mode
//     supports LIVE per-call approval, so the client can accept/decline each
//     command-execution / file-change request as it happens (CAP_LIVE_APPROVAL).
//   - "exec": drives `codex exec --json`, a one-shot streaming run with no live
//     approval hook, so it falls back to a static allowlist (CAP_ALLOWLIST).
//
// The real driver spawns one of those processes and pumps stdout notifications
// into `feedRaw`. The JSON-RPC schema should be regenerated via
// `codex app-server generate-ts` and pinned; `normalize.ts` holds the pure
// mapping so this file stays focused on the live transport + approval bookkeeping.

import type {
  Adapter,
  AdapterEventListener,
  ApprovalDecision,
  Capability,
} from "../interface.ts";
import { CAP_ALLOWLIST, CAP_LIVE_APPROVAL } from "../interface.ts";
import { type CodexRaw, normalizeCodex } from "./normalize.ts";

export type CodexMode = "app-server" | "exec";

export class CodexAdapter implements Adapter {
  readonly agent = "codex";
  readonly capability: Capability;

  private listener: AdapterEventListener | undefined;
  /** Approval ids the adapter has emitted and is waiting on a decision for. */
  private readonly pendingApprovals = new Set<string>();

  constructor(readonly mode: CodexMode) {
    this.capability = mode === "app-server" ? CAP_LIVE_APPROVAL : CAP_ALLOWLIST;
  }

  onEvent(listener: AdapterEventListener): void {
    this.listener = listener;
  }

  /**
   * Feed a raw JSON-RPC notification from the codex process. Runs the pure
   * normalizer and dispatches each resulting AdapterEvent to the listener,
   * tracking emitted approvals so resolveApproval can validate against them.
   */
  feedRaw(raw: CodexRaw): void {
    for (const event of normalizeCodex(raw)) {
      if (event.kind === "approval") this.pendingApprovals.add(event.approvalId);
      this.listener?.(event);
    }
  }

  async prompt(_text: string): Promise<void> {
    // Real driver writes a `sendUserMessage`/turn JSON-RPC request to stdin.
  }

  resolveApproval(approvalId: string, _decision: ApprovalDecision): void {
    // Real driver sends the accept/decline JSON-RPC response for this id.
    this.pendingApprovals.delete(approvalId);
  }

  interrupt(): void {
    // Real driver sends the interrupt JSON-RPC request for the current turn.
  }

  async stop(): Promise<void> {
    // Real driver terminates the spawned codex process/transport.
    this.pendingApprovals.clear();
  }
}
