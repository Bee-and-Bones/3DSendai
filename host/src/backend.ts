// U5 (plan-005) backend selection: which session source the host runs.
// Pure so host/bin/host.ts stays a thin shell and the rules are testable.
//
// SENDAI_BACKEND=agents|tmux|herdr picks the session source; unset now
// defaults to herdr (U8/plan 2026-07-20-001 — the agent-supervision board is
// the flagship path), or to tmux when the legacy SENDAI_TMUX=1 flag is set —
// preserved as an alias. `agents` (the pre-U8 default) remains an explicit,
// always-available value: nothing about the structured agent stack changed,
// only what runs when the env var is absent. Agreeing values are accepted;
// SENDAI_BACKEND=herdr with SENDAI_TMUX=1 is a contradiction and fatal.

export type BackendKind = "agents" | "tmux" | "herdr";

export function resolveBackend(env: Record<string, string | undefined>): BackendKind {
	const raw = (env.SENDAI_BACKEND ?? "").toLowerCase();
	const tmuxFlagRaw = (env.SENDAI_TMUX ?? "").toLowerCase();
	const tmuxFlag = tmuxFlagRaw === "1" || tmuxFlagRaw === "true";
	if (raw === "") return tmuxFlag ? "tmux" : "herdr";
	if (raw !== "agents" && raw !== "tmux" && raw !== "herdr") {
		throw new Error(`SENDAI_BACKEND must be agents | tmux | herdr (got: ${env.SENDAI_BACKEND})`);
	}
	if (raw === "herdr" && tmuxFlag) {
		throw new Error("SENDAI_BACKEND=herdr conflicts with SENDAI_TMUX=1 — unset one of them");
	}
	return raw;
}
