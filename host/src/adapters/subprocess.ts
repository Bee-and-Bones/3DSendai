// Shared line-delimited-JSON subprocess reader used by the CLI agent drivers
// (Claude Code, Codex). Spawns a process, streams stdout, parses each line as
// JSON, and invokes a callback. Killable and awaitable. Keeping this common
// keeps the drivers symmetric and small.

export interface JsonlProcess {
	/** Kill the child process. */
	kill(): void;
	/** Resolves with the exit code once stdout drains and the process exits. */
	done: Promise<number | null>;
}

export interface SpawnJsonlOptions {
	cmd: string[];
	cwd: string;
	onEvent: (event: unknown) => void;
	/** Optional: called with raw non-JSON stdout lines (diagnostics). */
	onNoise?: (line: string) => void;
}

export function spawnJsonl(opts: SpawnJsonlOptions): JsonlProcess {
	const child = Bun.spawn(opts.cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "ignore" });

	const done = (async (): Promise<number | null> => {
		const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buf = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				// biome-ignore lint/suspicious/noAssignInExpressions: deliberate line-splitting idiom, guarded by >= 0
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					let obj: unknown;
					try {
						obj = JSON.parse(line);
					} catch {
						opts.onNoise?.(line);
						continue;
					}
					opts.onEvent(obj);
				}
			}
		} finally {
			reader.releaseLock();
		}
		return await child.exited;
	})();

	return {
		kill: () => child.kill(),
		done,
	};
}
