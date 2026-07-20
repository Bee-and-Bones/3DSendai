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

	// Note: periodic re-enumeration is owned by the bridge's own refresh timer
	// (armRefresh/doRefresh calling refresh() each tick), covered in
	// herdrBridge.test.ts. Discovery itself is a stateless one-shot enumerator, so
	// there is no start()/dispose() loop here to exercise (F11).
});
