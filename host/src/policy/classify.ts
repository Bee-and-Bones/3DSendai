// Action classification (U12). A pure function that maps a tool name + its
// detail string to an action class and a risk level. This is the fail-safe
// input to policy.decide: anything we can't recognize is `unknown`/high, so
// the policy never auto-approves something we didn't understand.

export type ActionClass = "read" | "edit" | "shell" | "network" | "delete" | "unknown";

export interface Classification {
	class: ActionClass;
	risk: "low" | "high";
}

const READ_TOOLS = new Set(["read", "cat", "ls", "glob", "grep", "head", "tail"]);
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);
const SHELL_TOOLS = new Set(["bash", "sh", "shell", "zsh", "exec"]);

const NETWORK_RE = /\b(curl|wget|fetch|nc|ssh|scp)\b/;
const DELETE_RE = /\b(rm|unlink|rmdir|shred)\b/;

/** True when `detail` names a path that escapes the given repo root. */
function escapesRoot(detail: string, cwd: string): boolean {
	const root = cwd.replace(/\/+$/, "");
	for (const token of detail.split(/\s+/)) {
		if (token.startsWith("/") && !token.startsWith(`${root}/`) && token !== root) {
			return true;
		}
		if (token.includes("..")) return true;
	}
	return false;
}

/**
 * Classify an action by tool name plus detail heuristics. `cwd` (repo root)
 * lets us treat a path outside the repo as higher risk.
 */
export function classifyAction(tool: string, detail: string, cwd?: string): Classification {
	const name = tool.trim().toLowerCase();

	// Delete and network can hide inside a shell command, so check detail first.
	if (DELETE_RE.test(detail) || name === "rm" || name === "unlink") {
		return { class: "delete", risk: "high" };
	}
	if (NETWORK_RE.test(detail) || NETWORK_RE.test(name)) {
		return { class: "network", risk: "high" };
	}
	if (SHELL_TOOLS.has(name)) {
		return { class: "shell", risk: "high" };
	}
	if (READ_TOOLS.has(name)) {
		return { class: "read", risk: "low" };
	}
	if (EDIT_TOOLS.has(name)) {
		// Edits inside the repo are low-ish; escaping the root is higher risk.
		const risk = cwd && escapesRoot(detail, cwd) ? "high" : "low";
		return { class: "edit", risk };
	}

	// Unrecognized: fail safe.
	return { class: "unknown", risk: "high" };
}
