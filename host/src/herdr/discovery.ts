// U2 (plan 2026-07-20-001) herdr session discovery: enumerate the running
// herdr daemons the multi-session HerdrBridge (U4) attaches to.
//
// Ported from agentslate (MIT, Daniel Ou) `src/herdr.rs` discover_sessions —
// https://github.com/DanielOu1208/agentslate — for the running-filter and the
// default-first, then-alphabetical ordering. Revalidated against captured
// fixtures (host/test/fixtures/herdr/cli-session-list.txt) per AGENTS.md
// invariant #8; agentslate's code is a hypothesis about the wire, never ground
// truth. The `session list --json` entry shape at herdr 0.7.3 is
// `{default, name, running, session_dir, socket_path}`.
//
// The subprocess is injected as an array-form exec seam (matching the runner
// convention — never shell interpolation), so tests run hermetically against
// the CLI fixture. Re-enumeration timers are injected too (schedule/cancel),
// mirroring the bridge's timer-seam discipline.

import { resolveHerdrSocket } from "./runner.ts";
import { HerdrError } from "./socket.ts";

/** One `herdr session list --json` entry (foreign wire keys stay snake_case). */
export interface HerdrSessionEntry {
	name: string;
	default: boolean;
	running: boolean;
	session_dir?: string;
	socket_path?: string;
}

/** A resolved attach target: a session name plus the socket to dial. */
export interface HerdrTarget {
	/** herdr session name; undefined only for a socket-only explicit override. */
	session?: string;
	/** Unix socket path for the api socket. */
	socketPath: string;
}

/** Result of an array-form subprocess run. */
export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Array-form subprocess seam (no shell interpolation). */
export type ExecFn = (argv: string[]) => Promise<ExecResult>;

/** Opaque timer handle from the injected scheduler. */
export type TimerHandle = unknown;

export interface HerdrDiscoveryOptions {
	/** Injected array-form exec (default: liveExec()). */
	exec: ExecFn;
	/** herdr binary name (default "herdr"). */
	herdr?: string;
	/** Environment surface for the single-target override (default process.env). */
	env?: Record<string, string | undefined>;
	/** Home dir for session-name → socket resolution (default homedir()). */
	home?: string;
	/** Timer seam for periodic re-enumeration (default setTimeout). */
	schedule?: (fn: () => void, ms: number) => TimerHandle;
	/** Cancel a scheduled timer (default clearTimeout). */
	cancel?: (handle: TimerHandle) => void;
	/** Re-enumeration interval in ms (default 5000). */
	intervalMs?: number;
	/** Non-fatal log seam (default console.log). */
	log?: (msg: string) => void;
}

export interface HerdrDiscovery {
	/**
	 * True when a single explicit target is configured via env
	 * (SENDAI_HERDR_SOCKET / SENDAI_HERDR_SESSION): discovery is disabled and
	 * enumeration always yields that one target.
	 */
	readonly singleTarget: boolean;
	/**
	 * Enumerate running session targets once. In single-target mode returns the
	 * explicit target without spawning `herdr`. A missing binary, non-zero exit,
	 * or malformed output throws a typed HerdrError — never a hang.
	 */
	refresh(): Promise<HerdrTarget[]>;
	/**
	 * Begin periodic re-enumeration. `onChange` fires after every successful
	 * enumeration (including the first). In single-target mode it fires once with
	 * the explicit target and no timer is armed. A failed re-enumeration logs and
	 * keeps the schedule alive (the healthy set is unchanged until the next tick).
	 */
	start(onChange: (targets: HerdrTarget[]) => void): void;
	/** Stop periodic re-enumeration and cancel any pending timer. */
	dispose(): void;
}

/** Live array-form exec via Bun.spawn (used by U8 wiring; injected in tests). */
export function liveExec(): ExecFn {
	return async (argv: string[]): Promise<ExecResult> => {
		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		return { code, stdout, stderr };
	};
}

/**
 * Parse `herdr session list --json` stdout into attach targets: keep running
 * entries with a non-empty name, order default-first then alphabetical, resolve
 * each entry's socket (reported `socket_path`, else session-name derived).
 * Unknown entry fields are ignored (additive-daemon tolerance).
 */
export function parseSessionList(stdout: string, home?: string): HerdrTarget[] {
	let doc: unknown;
	try {
		doc = JSON.parse(stdout);
	} catch {
		throw new HerdrError(
			"discovery_failed",
			"herdr session list --json: output was not valid JSON",
		);
	}
	const sessions = (doc as { sessions?: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new HerdrError(
			"discovery_failed",
			"herdr session list --json: response missing sessions[] — incompatible CLI",
		);
	}
	const running = (sessions as Array<Record<string, unknown>>).filter(
		(s) => s.running === true && typeof s.name === "string" && s.name !== "",
	);
	running.sort((a, b) => {
		const ad = a.default === true;
		const bd = b.default === true;
		if (ad !== bd) return ad ? -1 : 1;
		return (a.name as string).localeCompare(b.name as string);
	});
	return running.map((s) => {
		const name = s.name as string;
		const socketPath =
			typeof s.socket_path === "string" && s.socket_path
				? s.socket_path
				: resolveHerdrSocket({ session: name }, home);
		return { session: name, socketPath };
	});
}

export function createHerdrDiscovery(opts: HerdrDiscoveryOptions): HerdrDiscovery {
	const herdr = opts.herdr ?? "herdr";
	const env = opts.env ?? (process.env as Record<string, string | undefined>);
	const home = opts.home;
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const intervalMs = opts.intervalMs ?? 5000;
	const log = opts.log ?? ((msg) => console.log(msg));

	// Single explicit target: SENDAI_HERDR_SOCKET wins (explicit path), else
	// SENDAI_HERDR_SESSION resolves to that session's socket. Either suppresses
	// enumeration entirely (today's single-target behavior).
	const explicitSocket = env.SENDAI_HERDR_SOCKET;
	const explicitSession = env.SENDAI_HERDR_SESSION;
	let single: HerdrTarget | undefined;
	if (explicitSocket) {
		single = { session: explicitSession, socketPath: explicitSocket };
	} else if (explicitSession) {
		single = {
			session: explicitSession,
			socketPath: resolveHerdrSocket({ session: explicitSession }, home),
		};
	}

	let timer: TimerHandle | undefined;
	let disposed = false;

	async function enumerate(): Promise<HerdrTarget[]> {
		if (single) return [single];
		let res: ExecResult;
		try {
			res = await opts.exec([herdr, "session", "list", "--json"]);
		} catch (err) {
			throw new HerdrError(
				"discovery_failed",
				`herdr session list --json: ${(err as Error).message}`,
			);
		}
		if (res.code !== 0) {
			const detail = res.stderr.trim() || `exit ${res.code}`;
			throw new HerdrError("discovery_failed", `herdr session list --json: ${detail}`);
		}
		return parseSessionList(res.stdout, home);
	}

	return {
		singleTarget: single !== undefined,

		refresh(): Promise<HerdrTarget[]> {
			return enumerate();
		},

		start(onChange: (targets: HerdrTarget[]) => void): void {
			if (disposed) return;
			const tick = () => {
				enumerate().then(
					(targets) => {
						if (disposed) return;
						onChange(targets);
						if (!single) arm();
					},
					(err) => {
						if (disposed) return;
						log(`herdr discovery: ${(err as Error).message}`);
						if (!single) arm();
					},
				);
			};
			const arm = () => {
				timer = schedule(tick, intervalMs);
			};
			tick();
		},

		dispose(): void {
			disposed = true;
			if (timer !== undefined) {
				cancel(timer);
				timer = undefined;
			}
		},
	};
}
