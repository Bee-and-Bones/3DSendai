// Live Claude Code adapter over the `claude` CLI (NOT the Agent SDK). Spawns
// `claude -p --output-format stream-json`, streams its events, normalizes them,
// and resumes the session on follow-up prompts. Streaming/permission-mode gated
// in this pass; live per-call approval (--permission-prompt-tool + a host MCP
// endpoint) is the scoped follow-up.

import type { Adapter, AdapterEvent, AdapterEventListener, ApprovalDecision } from "../interface.ts";
import { CAP_ALLOWLIST } from "../interface.ts";
import { spawnJsonl, type JsonlProcess } from "../subprocess.ts";
import { normalizeClaudeCli, extractClaudeSessionId, type ClaudeCliEvent } from "./cli-normalize.ts";

export type ClaudePermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions";

export interface ClaudeCliOptions {
  cwd: string;
  permissionMode?: ClaudePermissionMode;
  /** Override the claude binary (tests point this at a stub). */
  claudePath?: string;
  model?: string;
}

export class ClaudeCliAdapter implements Adapter {
  readonly agent = "claude";
  readonly capability = CAP_ALLOWLIST;

  private listener: AdapterEventListener | undefined;
  private sessionId: string | undefined;
  private proc: JsonlProcess | undefined;

  constructor(private readonly opts: ClaudeCliOptions) {}

  onEvent(listener: AdapterEventListener): void {
    this.listener = listener;
  }

  async prompt(text: string): Promise<void> {
    const bin = this.opts.claudePath ?? "claude";
    const args = [
      "-p",
      text,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.opts.permissionMode ?? "acceptEdits",
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.sessionId) args.push("--resume", this.sessionId);

    let sawTerminal = false;
    this.proc = spawnJsonl({
      cmd: [bin, ...args],
      cwd: this.opts.cwd,
      onEvent: (raw) => {
        const ev = raw as ClaudeCliEvent;
        const sid = extractClaudeSessionId(ev);
        if (sid) this.sessionId = sid;
        for (const e of normalizeClaudeCli(ev)) {
          if (e.kind === "done") sawTerminal = true;
          this.listener?.(e);
        }
      },
    });
    await this.proc.done;
    if (!sawTerminal) {
      this.listener?.({ kind: "error", message: "claude exited without completing the turn (check auth: run `claude` once to log in)" });
      this.listener?.({ kind: "done", status: "failed" });
    }
  }

  // No live per-call approval in this pass (capability.liveApproval === false).
  resolveApproval(_approvalId: string, _decision: ApprovalDecision): void {}

  interrupt(): void {
    this.proc?.kill();
  }

  async stop(): Promise<void> {
    this.proc?.kill();
  }
}
