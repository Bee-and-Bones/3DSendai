// Test double for the Adapter contract. Lets tests push normalized events and
// inspect what the registry routed back to the adapter.

import type { Adapter, AdapterEvent, AdapterEventListener, ApprovalDecision, Capability } from "../src/adapters/interface.ts";
import { CAP_LIVE_APPROVAL } from "../src/adapters/interface.ts";

export class FakeAdapter implements Adapter {
  private listener: AdapterEventListener | undefined;
  readonly prompts: string[] = [];
  readonly approvals: Array<{ approvalId: string; decision: ApprovalDecision }> = [];
  interrupts = 0;
  stopped = false;

  constructor(
    readonly agent: string = "claude",
    readonly capability: Capability = CAP_LIVE_APPROVAL,
  ) {}

  onEvent(listener: AdapterEventListener): void {
    this.listener = listener;
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.push({ approvalId, decision });
  }
  interrupt(): void {
    this.interrupts += 1;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** Test-only: push a normalized event as if the CLI produced it. */
  emit(event: AdapterEvent): void {
    this.listener?.(event);
  }
}
