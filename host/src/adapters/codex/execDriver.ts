// Live Codex adapter over `codex exec --json` (M1 driver). Spawns the real
// codex CLI per prompt, streams its JSONL events, normalizes them to
// AdapterEvents, and captures the thread id so follow-up prompts resume the
// same session. Allowlist/sandbox-gated (no live per-call approval); that is
// the codex app-server path (normalize.ts), a follow-up.

import type {
	Adapter,
	AdapterEvent,
	AdapterEventListener,
	ApprovalDecision,
} from "../interface.ts";
import { CAP_ALLOWLIST } from "../interface.ts";
import { type JsonlProcess, spawnJsonl } from "../subprocess.ts";
import { type CodexExecEvent, extractThreadId, normalizeCodexExec } from "./execNormalize.ts";

export interface CodexExecOptions {
	cwd: string;
	sandbox?: "read-only" | "workspace-write" | "danger-full-access";
	/** Override the codex binary (tests point this at a stub). */
	codexPath?: string;
	/** Extra args (e.g. --skip-git-repo-check). */
	extraArgs?: string[];
}

export class CodexExecAdapter implements Adapter {
	readonly agent = "codex";
	readonly capability = CAP_ALLOWLIST;

	private listener: AdapterEventListener | undefined;
	private threadId: string | undefined;
	private proc: JsonlProcess | undefined;

	constructor(private readonly opts: CodexExecOptions) {}

	onEvent(listener: AdapterEventListener): void {
		this.listener = listener;
	}

	async prompt(text: string): Promise<void> {
		const bin = this.opts.codexPath ?? "codex";
		const base = [
			"exec",
			"--json",
			"--skip-git-repo-check",
			"--sandbox",
			this.opts.sandbox ?? "workspace-write",
			"-C",
			this.opts.cwd,
			...(this.opts.extraArgs ?? []),
		];
		const args = this.threadId
			? [
					"exec",
					"resume",
					this.threadId,
					"--json",
					"--skip-git-repo-check",
					"-C",
					this.opts.cwd,
					text,
				]
			: [...base, text];

		let sawTerminal = false;
		this.proc = spawnJsonl({
			cmd: [bin, ...args],
			cwd: this.opts.cwd,
			onEvent: (raw) => {
				const ev = raw as CodexExecEvent;
				const tid = extractThreadId(ev);
				if (tid) this.threadId = tid;
				for (const e of normalizeCodexExec(ev)) {
					if (e.kind === "done") sawTerminal = true;
					this.listener?.(e);
				}
			},
		});
		await this.proc.done;
		if (!sawTerminal) {
			this.listener?.({ kind: "error", message: "codex exited without completing the turn" });
			this.listener?.({ kind: "done", status: "failed" });
		}
	}

	// Exec mode has no live approval; the registry never calls this for a codex-exec
	// tile (capability.liveApproval === false), but the interface requires it.
	resolveApproval(_approvalId: string, _decision: ApprovalDecision): void {}

	interrupt(): void {
		this.proc?.kill();
	}

	async stop(): Promise<void> {
		this.proc?.kill();
	}
}
