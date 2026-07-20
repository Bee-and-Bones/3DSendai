// U4 (plan-005) live HerdrRunner: the Bun side of the herdr seam. Kept out of
// bridge.ts so the bridge stays hermetically testable (bridge takes an
// injected HerdrRunner). This is the only file that touches a real herdr.
//
// The control channel is `herdr [--session <name>] terminal session control
// <pane> --takeover --cols C --rows R` over plain pipes — NDJSON both ways,
// no PTY needed (U1). --takeover so a device reconnect replaces the stale
// channel a dead host left behind.
//
// U4 (plan 2026-07-20-001): the multi-session HerdrBridge builds one runner per
// discovered session through createHerdrRunnerFactory — it dials the session's
// reported socket_path and passes `--session <name>` for every named session
// (the CLI special-cases the literal `default` to the top-level socket, per the
// U1 default-session addressing rule).

import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrChild, HerdrRunner } from "./bridge.ts";
import type { HerdrTarget } from "./discovery.ts";
import { herdrDialer } from "./socket.ts";

export interface HerdrRunnerOptions {
	/** Named herdr session; omit for the default session. */
	session?: string;
	/** Explicit api socket path; overrides the session-derived default. */
	socket?: string;
	/** herdr binary (default "herdr"). */
	herdr?: string;
}

/**
 * herdr's own socket layout: the default session lives at
 * ~/.config/herdr/herdr.sock, a named session at
 * ~/.config/herdr/sessions/<name>/herdr.sock. Explicit path wins. The literal
 * session name "default" is NOT a directory under sessions/ — it addresses the
 * top-level socket (fixtures README §default-session addressing), so
 * SENDAI_HERDR_SESSION=default resolves to ~/.config/herdr/herdr.sock, not a
 * nonexistent sessions/default/herdr.sock.
 */
export function resolveHerdrSocket(opts: HerdrRunnerOptions, home: string = homedir()): string {
	if (opts.socket) return opts.socket;
	if (opts.session && opts.session !== "default")
		return join(home, ".config", "herdr", "sessions", opts.session, "herdr.sock");
	return join(home, ".config", "herdr", "herdr.sock");
}

/**
 * Pump a control-channel stdout stream to `getOnData`, ending the channel via
 * `getOnExit` on a reader/pipe error instead of letting the rejection escape as
 * an unhandled promise rejection that crashes the whole host process (F3). A
 * normal EOF (`done: true`) resolves cleanly and is surfaced via the separate
 * child.exited seam; here we only need to contain the ERROR path — a broken pipe
 * ends this channel exactly as an EOF would, never taking down the process.
 *
 * onData/onExit are read through getters because the caller assigns them AFTER
 * spawnControl returns (the bridge wires child.onData(...) later). Exported for
 * hermetic testing without a live herdr child.
 */
export function pumpControlStdout(
	stream: ReadableStream<Uint8Array>,
	getOnData: () => ((bytes: Uint8Array) => void) | undefined,
	getOnExit: () => (() => void) | undefined,
): void {
	void (async () => {
		const reader = stream.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) getOnData()?.(value);
			}
		} finally {
			reader.releaseLock();
		}
	})().catch(() => {
		// A reader/pipe error: end the channel (channel-closed), do not crash.
		getOnExit()?.();
	});
}

export function createHerdrRunner(opts: HerdrRunnerOptions = {}): HerdrRunner {
	const herdr = opts.herdr ?? "herdr";
	const base = opts.session ? [herdr, "--session", opts.session] : [herdr];

	return {
		dial: herdrDialer(resolveHerdrSocket(opts)),

		spawnControl(paneId: string, cols: number, rows: number): HerdrChild {
			const child = Bun.spawn(
				[
					...base,
					"terminal",
					"session",
					"control",
					paneId,
					"--takeover",
					"--cols",
					String(cols),
					"--rows",
					String(rows),
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "inherit" },
			);

			let onData: ((bytes: Uint8Array) => void) | undefined;
			let onExit: (() => void) | undefined;

			pumpControlStdout(
				child.stdout as ReadableStream<Uint8Array>,
				() => onData,
				() => onExit,
			);

			void child.exited.then(() => onExit?.());

			return {
				onData(listener) {
					onData = listener;
				},
				onExit(listener) {
					onExit = listener;
				},
				write(line: string) {
					const w = (child.stdin as { write(chunk: Uint8Array): void }).write;
					w.call(child.stdin, new TextEncoder().encode(line + "\n"));
					(child.stdin as { flush?(): void }).flush?.();
				},
				kill() {
					child.kill();
				},
			};
		},
	};
}

/**
 * Build a per-target HerdrRunner factory for the multi-session bridge (U4). Each
 * target carries its session name and the socket_path discovery reported; the
 * factory dials that socket directly and qualifies control-channel spawns with
 * `--session <name>`. A target without a session name (a socket-only explicit
 * override) spawns unqualified against the default session.
 */
export function createHerdrRunnerFactory(
	opts: { herdr?: string } = {},
): (target: HerdrTarget) => HerdrRunner {
	return (target: HerdrTarget) =>
		createHerdrRunner({ session: target.session, socket: target.socketPath, herdr: opts.herdr });
}
