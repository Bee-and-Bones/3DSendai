// U2 (plan 2026-07-20-001) herdr session discovery tests. Hermetic: an injected
// exec seam replays the U1 CLI fixture (host/test/fixtures/herdr/
// cli-session-list.txt), and an injected scheduler drives re-enumeration.

import { describe, expect, test } from "bun:test";
import {
	createHerdrDiscovery,
	type ExecFn,
	type ExecResult,
	parseSessionList,
} from "../src/herdr/discovery.ts";

// The CLI fixture is `CMD <argv>` / `OUT <json>` pairs; pull the OUT payloads.
const FIXTURE = await Bun.file(
	new URL("./fixtures/herdr/cli-session-list.txt", import.meta.url),
).text();
const OUT_LINES = FIXTURE.split("\n")
	.filter((l) => l.startsWith("OUT "))
	.map((l) => l.slice("OUT ".length));
const ONE_RUNNING = OUT_LINES[0]!; // default stopped + one running
const TWO_RUNNING = OUT_LINES[1]!; // default stopped + two running

function fixedExec(
	out: string,
	opts: { code?: number; stderr?: string } = {},
): {
	exec: ExecFn;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: ExecFn = async (argv) => {
		calls.push(argv);
		return { code: opts.code ?? 0, stdout: out, stderr: opts.stderr ?? "" } satisfies ExecResult;
	};
	return { exec, calls };
}

/** A scheduler that captures the pending callback so a test can fire it. */
function fakeScheduler() {
	let pending: (() => void) | undefined;
	let armed = 0;
	let cancelled = 0;
	return {
		schedule: (fn: () => void) => {
			pending = fn;
			armed += 1;
			return armed;
		},
		cancel: () => {
			cancelled += 1;
			pending = undefined;
		},
		fire: () => {
			const fn = pending;
			pending = undefined;
			fn?.();
		},
		get armed() {
			return armed;
		},
		get cancelled() {
			return cancelled;
		},
		get hasPending() {
			return pending !== undefined;
		},
	};
}

describe("herdr discovery", () => {
	test("filters to running sessions and orders default-first then alphabetical", async () => {
		const { exec, calls } = fixedExec(TWO_RUNNING);
		const disc = createHerdrDiscovery({ exec });
		const targets = await disc.refresh();
		// default is stopped in the fixture, so it is excluded; the two running
		// scratch sessions sort alphabetically (both default:false).
		expect(targets.map((t) => t.session)).toEqual(["3dsendai-spike", "3dsendai-spike2"]);
		expect(targets[0]!.socketPath).toBe(
			"/home/user/.config/herdr/sessions/3dsendai-spike/herdr.sock",
		);
		// Array-form spawn, never a shell string.
		expect(calls[0]).toEqual(["herdr", "session", "list", "--json"]);
	});

	test("a running default session sorts ahead of named sessions", () => {
		const targets = parseSessionList(
			JSON.stringify({
				sessions: [
					{ name: "alpha", default: false, running: true, socket_path: "/s/alpha.sock" },
					{ name: "default", default: true, running: true, socket_path: "/s/default.sock" },
				],
			}),
		);
		expect(targets.map((t) => t.session)).toEqual(["default", "alpha"]);
	});

	test("one-running fixture yields exactly the running scratch session", async () => {
		const { exec } = fixedExec(ONE_RUNNING);
		const targets = await createHerdrDiscovery({ exec }).refresh();
		expect(targets.map((t) => t.session)).toEqual(["3dsendai-spike"]);
	});

	test("empty session list is an empty result, not an error", async () => {
		const { exec } = fixedExec(JSON.stringify({ sessions: [] }));
		expect(await createHerdrDiscovery({ exec }).refresh()).toEqual([]);
	});

	test("all-stopped sessions yield an empty result", async () => {
		const { exec } = fixedExec(
			JSON.stringify({ sessions: [{ name: "default", default: true, running: false }] }),
		);
		expect(await createHerdrDiscovery({ exec }).refresh()).toEqual([]);
	});

	test("unknown entry fields are ignored", async () => {
		const { exec } = fixedExec(
			JSON.stringify({
				schema_version: 2,
				sessions: [
					{
						name: "s1",
						default: false,
						running: true,
						socket_path: "/s/s1.sock",
						future_field: { nested: true },
						pid: 1234,
					},
				],
			}),
		);
		const targets = await createHerdrDiscovery({ exec }).refresh();
		expect(targets).toEqual([{ session: "s1", socketPath: "/s/s1.sock" }]);
	});

	test("malformed JSON throws a typed discovery error", async () => {
		const { exec } = fixedExec("not json at all");
		await expect(createHerdrDiscovery({ exec }).refresh()).rejects.toMatchObject({
			code: "discovery_failed",
		});
	});

	test("missing sessions[] throws a typed discovery error", async () => {
		const { exec } = fixedExec(JSON.stringify({ something: "else" }));
		await expect(createHerdrDiscovery({ exec }).refresh()).rejects.toMatchObject({
			code: "discovery_failed",
		});
	});

	test("non-zero exit throws a typed discovery error carrying stderr", async () => {
		const { exec } = fixedExec("", { code: 127, stderr: "herdr: command not found" });
		await expect(createHerdrDiscovery({ exec }).refresh()).rejects.toMatchObject({
			code: "discovery_failed",
			message: expect.stringContaining("command not found"),
		});
	});

	test("an exec that throws (missing binary) becomes a typed error, never a hang", async () => {
		const exec: ExecFn = async () => {
			throw new Error("spawn herdr ENOENT");
		};
		await expect(createHerdrDiscovery({ exec }).refresh()).rejects.toMatchObject({
			code: "discovery_failed",
			message: expect.stringContaining("ENOENT"),
		});
	});

	test("SENDAI_HERDR_SOCKET suppresses discovery: single explicit target, no exec", async () => {
		const { exec, calls } = fixedExec(TWO_RUNNING);
		const disc = createHerdrDiscovery({
			exec,
			env: { SENDAI_HERDR_SOCKET: "/tmp/explicit.sock", SENDAI_HERDR_SESSION: "work" },
		});
		expect(disc.singleTarget).toBe(true);
		expect(await disc.refresh()).toEqual([{ session: "work", socketPath: "/tmp/explicit.sock" }]);
		expect(calls.length).toBe(0);
	});

	test("SENDAI_HERDR_SESSION alone resolves the session socket and suppresses discovery", async () => {
		const { exec, calls } = fixedExec(TWO_RUNNING);
		const disc = createHerdrDiscovery({
			exec,
			home: "/home/u",
			env: { SENDAI_HERDR_SESSION: "work" },
		});
		expect(disc.singleTarget).toBe(true);
		expect(await disc.refresh()).toEqual([
			{ session: "work", socketPath: "/home/u/.config/herdr/sessions/work/herdr.sock" },
		]);
		expect(calls.length).toBe(0);
	});

	test("scheduled re-enumeration fires through the injected timer and stops on dispose", async () => {
		const { exec, calls } = fixedExec(ONE_RUNNING);
		const sched = fakeScheduler();
		const disc = createHerdrDiscovery({ exec, schedule: sched.schedule, cancel: sched.cancel });
		const seen: number[] = [];
		disc.start((targets) => seen.push(targets.length));
		// Initial enumeration is async (exec is a promise); let it settle.
		await Bun.sleep(1);
		expect(seen).toEqual([1]); // fired once on start
		expect(sched.hasPending).toBe(true); // and armed the next tick
		sched.fire();
		await Bun.sleep(1);
		expect(seen).toEqual([1, 1]); // re-enumeration delivered again
		expect(calls.length).toBe(2);
		disc.dispose();
		expect(sched.cancelled).toBeGreaterThan(0);
		// A tick that somehow fires after dispose delivers nothing further.
		sched.fire();
		await Bun.sleep(1);
		expect(seen).toEqual([1, 1]);
	});

	test("single-target start fires onChange once and arms no timer", async () => {
		const { exec } = fixedExec(TWO_RUNNING);
		const sched = fakeScheduler();
		const disc = createHerdrDiscovery({
			exec,
			schedule: sched.schedule,
			cancel: sched.cancel,
			env: { SENDAI_HERDR_SOCKET: "/tmp/x.sock" },
		});
		const seen: number[] = [];
		disc.start((targets) => seen.push(targets.length));
		await Bun.sleep(1);
		expect(seen).toEqual([1]);
		expect(sched.armed).toBe(0); // no periodic timer in single-target mode
	});

	test("a failed re-enumeration keeps the schedule alive without crashing", async () => {
		let call = 0;
		const exec: ExecFn = async () => {
			call += 1;
			if (call === 1) return { code: 0, stdout: ONE_RUNNING, stderr: "" };
			return { code: 1, stdout: "", stderr: "daemon gone" };
		};
		const sched = fakeScheduler();
		const disc = createHerdrDiscovery({
			exec,
			schedule: sched.schedule,
			cancel: sched.cancel,
			log: () => {},
		});
		const seen: number[] = [];
		disc.start((targets) => seen.push(targets.length));
		await Bun.sleep(1);
		expect(seen).toEqual([1]);
		sched.fire(); // second enumeration fails
		await Bun.sleep(1);
		expect(seen).toEqual([1]); // no new delivery, but no throw
		expect(sched.hasPending).toBe(true); // still scheduled for a retry
		disc.dispose();
	});
});
