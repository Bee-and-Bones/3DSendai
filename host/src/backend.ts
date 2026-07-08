// U5 (plan-005) backend selection: which session source the host runs.
// Pure so host/bin/host.ts stays a thin shell and the rules are testable.
//
// SENDAI_BACKEND=tmux|herdr picks a terminal-mode backend; unset keeps the
// existing behavior (agent adapters, or tmux when the legacy SENDAI_TMUX=1
// flag is set — preserved as an alias). Agreeing values are accepted;
// SENDAI_BACKEND=herdr with SENDAI_TMUX=1 is a contradiction and fatal.

export type BackendKind = "agents" | "tmux" | "herdr";

export function resolveBackend(env: Record<string, string | undefined>): BackendKind {
	const raw = (env.SENDAI_BACKEND ?? "").toLowerCase();
	const tmuxFlagRaw = (env.SENDAI_TMUX ?? "").toLowerCase();
	const tmuxFlag = tmuxFlagRaw === "1" || tmuxFlagRaw === "true";
	if (raw === "") return tmuxFlag ? "tmux" : "agents";
	if (raw !== "tmux" && raw !== "herdr") {
		throw new Error(`SENDAI_BACKEND must be tmux | herdr (got: ${env.SENDAI_BACKEND})`);
	}
	if (raw === "herdr" && tmuxFlag) {
		throw new Error("SENDAI_BACKEND=herdr conflicts with SENDAI_TMUX=1 — unset one of them");
	}
	return raw;
}
