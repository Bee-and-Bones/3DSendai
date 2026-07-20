// U4 (plan 2026-07-20-001) HerdrBridge tests. Hermetic: fake HerdrRunners
// provide fake api-socket daemons (fixture-shaped responses) and fake
// control-channel children — no live herdr.
//
// Two construction paths are exercised: back-compat single-target ({ runner })
// and multi-session ({ makeRunner, discover, schedule, cancel }). Fakes are
// shaped on host/test/fixtures/herdr/{socket-snapshot-agents,cli-session-list}:
// panes[] carries agent/display_agent/title/agent_status inline at 0.7.3, and
// discovery yields default-first {session, socketPath} targets.
//
// Channels are LAZY (U4): a bare attach opens no control channel and issues no
// pane.focus; FOCUS_SESSION opens the channel (repaint = its first full frame);
// resync re-opens ONLY a channel that was already open. Where the scenario
// wording predates the U1 decision (pane.read repaints, send_input key names),
// the assertions target the shipped control-channel design.

import { describe, expect, test } from "bun:test";
import {
	fromHex,
	MSG,
	type AlertSignalPayload,
	type SessionListPayload,
	type SessionSummary,
	type TerminalDataPayload,
	toHex,
} from "@agentbus/protocol";
import {
	HerdrBridge,
	type HerdrChild,
	type HerdrRunner,
	type MakeRunner,
	sanitizeLabel,
	stripOsc,
} from "../src/herdr/bridge.ts";
import type { HerdrTarget } from "../src/herdr/discovery.ts";
import type { HerdrConn, HerdrDial } from "../src/herdr/socket.ts";

interface Emitted {
	type: number;
	sessionId: number;
	payload: unknown;
}

function collector() {
	const frames: Emitted[] = [];
	const sink = (type: number, sessionId: number, payload: unknown) =>
		frames.push({ type, sessionId, payload });
	const of = (type: number) => frames.filter((f) => f.type === type);
	const alerts = (cls: string) =>
		frames.filter(
			(f) => f.type === MSG.ALERT_SIGNAL && (f.payload as AlertSignalPayload).class === cls,
		);
	const lastList = () => of(MSG.SESSION_LIST).at(-1)!.payload as SessionListPayload;
	return { frames, sink, of, alerts, lastList };
}

// --- fake control-channel child -------------------------------------------------

class FakeChild implements HerdrChild {
	dataListener: ((b: Uint8Array) => void) | undefined;
	exitListener: (() => void) | undefined;
	writes: string[] = [];
	killed = false;
	constructor(
		readonly paneId: string,
		readonly cols: number,
		readonly rows: number,
	) {}
	onData(l: (b: Uint8Array) => void) {
		this.dataListener = l;
	}
	onExit(l: () => void) {
		this.exitListener = l;
	}
	write(line: string) {
		this.writes.push(line);
	}
	kill() {
		this.killed = true;
	}
	/** Feed one NDJSON record as the herdr CLI would print it. */
	record(rec: unknown) {
		this.dataListener?.(new TextEncoder().encode(JSON.stringify(rec) + "\n"));
	}
	frame(bytes: string | Uint8Array, extra: Record<string, unknown> = {}) {
		const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
		this.record({
			type: "terminal.frame",
			seq: 1,
			full: true,
			width: this.cols,
			height: this.rows,
			encoding: "base64",
			bytes: Buffer.from(raw).toString("base64"),
			...extra,
		});
	}
}

// --- fake daemon + runner --------------------------------------------------------

interface FakePane {
	pane_id: string;
	tab_id?: string;
	workspace_id?: string;
	title?: string | null;
	agent?: string | null;
	display_agent?: string | null;
	agent_status?: string;
	focused?: boolean;
}

interface FakeDaemonOpts {
	protocol?: number;
	failDial?: boolean;
	/** workspace_id -> label; default {w1: "work"}. */
	workspaces?: Record<string, string>;
}

type FakeConn = HerdrConn & { feed(text: string): void; close(): void; ended: boolean };

function fakeHerdr(initialPanes: FakePane[], opts: FakeDaemonOpts = {}) {
	const wsLabels = opts.workspaces ?? { w1: "work" };
	const panes = initialPanes.map((p) => ({
		pane_id: p.pane_id,
		terminal_id: `term_${p.pane_id}`,
		workspace_id: p.workspace_id ?? "w1",
		tab_id: p.tab_id ?? "w1:t1",
		focused: p.focused ?? false,
		agent_status: p.agent_status ?? "unknown",
		agent: p.agent ?? null,
		display_agent: p.display_agent ?? null,
		title: p.title ?? null,
	}));
	const state = {
		panes,
		protocol: opts.protocol ?? 16,
		failDial: opts.failDial ?? false,
		children: [] as FakeChild[],
		subConns: [] as Array<{ conn: FakeConn; subs: Array<Record<string, unknown>> }>,
		requests: [] as Array<Record<string, unknown>>,
	};

	class FakeConnImpl implements HerdrConn {
		dataListener: ((b: Uint8Array) => void) | undefined;
		closeListener: (() => void) | undefined;
		ended = false;
		write(line: string) {
			const msg = JSON.parse(line) as {
				id: string;
				method: string;
				params?: Record<string, unknown>;
			};
			state.requests.push(msg);
			const reply = (obj: unknown) => this.feed(JSON.stringify(obj) + "\n");
			switch (msg.method) {
				case "ping":
					reply({ id: msg.id, result: { type: "pong", version: "0.7.3", protocol: state.protocol } });
					this.close();
					return;
				case "session.snapshot":
					reply({
						id: msg.id,
						result: {
							type: "session_snapshot",
							snapshot: {
								version: "0.7.3",
								protocol: state.protocol,
								focused_pane_id: state.panes.find((p) => p.focused)?.pane_id,
								workspaces: Object.entries(wsLabels).map(([workspace_id, label]) => ({
									workspace_id,
									label,
								})),
								tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
								panes: state.panes,
							},
						},
					});
					this.close();
					return;
				case "events.subscribe":
					state.subConns.push({
						conn: this,
						subs: (msg.params?.subscriptions ?? []) as Array<Record<string, unknown>>,
					});
					reply({ id: msg.id, result: { type: "subscription_started" } });
					return;
				default:
					reply({
						id: msg.id,
						error: { code: "invalid_request", message: `unknown method ${msg.method}` },
					});
					this.close();
			}
		}
		onData(l: (b: Uint8Array) => void) {
			this.dataListener = l;
		}
		onClose(l: () => void) {
			this.closeListener = l;
		}
		end() {
			this.ended = true;
		}
		feed(text: string) {
			this.dataListener?.(new TextEncoder().encode(text));
		}
		close() {
			this.closeListener?.();
		}
	}

	const dial: HerdrDial = async () => {
		if (state.failDial) throw new Error("connect ENOENT herdr.sock");
		return new FakeConnImpl();
	};

	const runner: HerdrRunner = {
		dial,
		spawnControl(paneId, cols, rows) {
			const child = new FakeChild(paneId, cols, rows);
			state.children.push(child);
			return child;
		},
	};

	/** Push an event to the newest live subscribe connection (as the daemon does). */
	function push(event: string, data: Record<string, unknown>) {
		const live = [...state.subConns].reverse().find((s) => !s.conn.ended);
		live?.conn.feed(JSON.stringify({ data, event }) + "\n");
	}
	/** Latest live subscription's requested types (for resubscribe assertions). */
	function currentSubs(): Array<Record<string, unknown>> {
		return [...state.subConns].reverse().find((s) => !s.conn.ended)?.subs ?? [];
	}
	function dropSubscription() {
		const live = [...state.subConns].reverse().find((s) => !s.conn.ended);
		live?.conn.close();
	}

	return { state, runner, push, currentSubs, dropSubscription };
}

type FakeDaemon = ReturnType<typeof fakeHerdr>;

const lastChild = (fake: FakeDaemon) => fake.state.children.at(-1)!;

function terminalHex(frames: Emitted[], sessionId: number): string {
	return frames
		.filter((f) => f.type === MSG.TERMINAL_DATA && (f.payload as TerminalDataPayload).sessionId === sessionId)
		.map((f) => (f.payload as TerminalDataPayload).hex)
		.join("");
}

// --- single-target harness ------------------------------------------------------

async function startedBridge(panes: FakePane[], opts: { size?: { cols: number; rows: number } } = {}) {
	const fake = fakeHerdr(panes);
	const c = collector();
	const bridge = new HerdrBridge({ runner: fake.runner, sink: c.sink, log: () => {} });
	bridge.start();
	await Bun.sleep(1);
	if (opts.size) bridge.route(MSG.CLIENT_SIZE, 0, opts.size);
	return { fake, c, bridge };
}

/** Focus a device session id and return the freshly-spawned control child. */
function focus(bridge: HerdrBridge, fake: FakeDaemon, sessionId: number): FakeChild {
	bridge.route(MSG.FOCUS_SESSION, 0, { sessionId });
	return lastChild(fake);
}

// --- multi-session harness ------------------------------------------------------

interface DaemonConfig {
	panes: FakePane[];
	failDial?: boolean;
	protocol?: number;
	workspaces?: Record<string, string>;
}

function multiHarness(config: Record<string, DaemonConfig>) {
	const daemons: Record<string, FakeDaemon> = {};
	for (const [name, cfg] of Object.entries(config)) {
		daemons[name] = fakeHerdr(cfg.panes, {
			protocol: cfg.protocol,
			failDial: cfg.failDial,
			workspaces: cfg.workspaces,
		});
	}
	// Default-first, then alphabetical (the discovery ordering U2 guarantees).
	let targets: HerdrTarget[] = Object.keys(config)
		.sort()
		.map((name) => ({ session: name, socketPath: `/sock/${name}` }));

	const discover = async () => targets;
	const makeRunner: MakeRunner = (target) => daemons[target.session ?? ""]!.runner;

	const scheduled: Array<() => void> = [];
	const schedule = (fn: () => void, _ms: number) => {
		scheduled.push(fn);
		return fn;
	};
	const cancel = (h: unknown) => {
		const i = scheduled.indexOf(h as () => void);
		if (i >= 0) scheduled.splice(i, 1);
	};
	/** Fire the pending re-enumeration tick and let its async work settle. */
	const fireRefresh = async () => {
		const fn = scheduled.pop();
		fn?.();
		await Bun.sleep(1);
	};
	const setTargets = (names: string[]) => {
		targets = names.map((name) => ({ session: name, socketPath: `/sock/${name}` }));
	};

	return { daemons, discover, makeRunner, schedule, cancel, fireRefresh, setTargets };
}

async function startedMulti(config: Record<string, DaemonConfig>) {
	const h = multiHarness(config);
	const c = collector();
	const bridge = new HerdrBridge({
		makeRunner: h.makeRunner,
		discover: h.discover,
		schedule: h.schedule,
		cancel: h.cancel,
		refreshMs: 1000,
		sink: c.sink,
		log: () => {},
	});
	bridge.start();
	await Bun.sleep(1);
	return { h, c, bridge };
}

// ================================================================================

describe("helpers", () => {
	test("sanitizeLabel strips control/escape bytes and truncates", () => {
		// ESC/BEL/CR/LF stripped; printable remnants of an escape body survive as text.
		expect(sanitizeLabel("herdr:1/\x1b]0;evil\x07title\r\n")).toBe("herdr:1/]0;eviltitle");
		expect(sanitizeLabel("a".repeat(100)).length).toBe(40);
		expect(sanitizeLabel("plain")).toBe("plain");
	});

	test("stripOsc removes BEL- and ST-terminated OSC sequences, keeps the rest", () => {
		const input = new TextEncoder().encode("\x1b[?25l\x1b]8;;\x1b\\\x1b[2J\x1b[Hhi\x1b]0;title\x07!");
		const out = new TextDecoder().decode(stripOsc(input));
		expect(out).toBe("\x1b[?25l\x1b[2J\x1b[Hhi!");
	});
});

describe("herdr bridge — enumeration & board (single target)", () => {
	test("emits SESSION_STATE per pane then SESSION_LIST; labels carry tab/title; single daemon is unprefixed", async () => {
		const { c } = await startedBridge([
			{ pane_id: "w1:p1", title: "vim", focused: true },
			{ pane_id: "w1:p2", agent: "claude", agent_status: "working", title: "claude build" },
		]);
		const states = c.of(MSG.SESSION_STATE);
		expect(states.length).toBe(2);
		const agents = states.map((s) => (s.payload as SessionSummary).agent).sort();
		// Single-daemon: no `<session>/` prefix (back-compat with pre-refactor labels).
		expect(agents).toEqual(["herdr:1/claude build [claude]", "herdr:1/vim"]);
		const list = c.lastList();
		expect(list.sessions.length).toBe(2);
		expect(list.sessions.find((s) => s.agent.includes("claude"))!.status).toBe("running_tool");
		// SESSION_STATE frames precede the SESSION_LIST boundary (per-object emission).
		const listIdx = c.frames.findIndex((f) => f.type === MSG.SESSION_LIST);
		expect(c.frames.slice(0, listIdx).filter((f) => f.type === MSG.SESSION_STATE).length).toBe(2);
	});

	test("enriched fields flow through when present and are omitted when absent", async () => {
		// Shaped on socket-snapshot-agents.ndjson: agent/display_agent/title inline
		// on panes[], plus an agentless pane that stays a bare board row.
		const { c } = await startedBridge([
			{
				pane_id: "w1:p1",
				agent: "codex",
				display_agent: "Codex",
				title: "codex review",
				agent_status: "blocked",
				focused: true,
			},
			{ pane_id: "w1:p2", agent_status: "unknown" },
		]);
		const list = c.lastList();
		const enriched = list.sessions.find((s) => s.agent.includes("codex"))!;
		expect(enriched.kind).toBe("codex");
		expect(enriched.agentName).toBe("Codex");
		expect(enriched.title).toBe("codex review");
		expect(enriched.workspace).toBe("work");
		expect(enriched.status).toBe("blocked");
		const bare = list.sessions.find((s) => !s.agent.includes("codex"))!;
		// Agentless pane: no kind/agentName/title; workspace still carries its label.
		expect(bare.kind).toBeUndefined();
		expect(bare.agentName).toBeUndefined();
		expect(bare.title).toBeUndefined();
		expect(bare.workspace).toBe("work");
		expect(bare.status).toBe("unknown");
	});

	test("agentName falls back to raw agent when display_agent is absent", async () => {
		const { c } = await startedBridge([
			{ pane_id: "w1:p1", agent: "opencode", agent_status: "idle", focused: true },
		]);
		const s = c.lastList().sessions[0]!;
		expect(s.kind).toBe("opencode");
		expect(s.agentName).toBe("opencode");
		expect(s.status).toBe("idle");
	});

	test("control bytes embedded in a pane title are stripped before emission (R2)", async () => {
		const { c } = await startedBridge([
			{ pane_id: "w1:p1", agent: "claude", title: "ta\x07b\x1bX", agent_status: "working", focused: true },
		]);
		const s = c.lastList().sessions[0]!;
		expect(s.title).toBe("tabX");
		// The decorated legacy label is likewise scrubbed of the control bytes.
		for (const ch of `${s.agent}${s.title}`) expect(ch.codePointAt(0)!).toBeGreaterThanOrEqual(0x20);
	});

	test("an unrecognized agent_status maps to the 'unknown' union member", async () => {
		const { c } = await startedBridge([
			{ pane_id: "w1:p1", agent: "claude", agent_status: "frobnicate", focused: true },
		]);
		expect(c.lastList().sessions[0]!.status).toBe("unknown");
	});

	test("zero panes is an empty board that gains a session on pane_created, not an error", async () => {
		const { fake, c } = await startedBridge([]);
		expect(c.of(MSG.ERROR).length).toBe(0);
		expect(c.lastList().sessions).toEqual([]);
		fake.push("pane_created", {
			pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "unknown", agent: null, title: "sh" },
		});
		await Bun.sleep(1);
		const list = c.lastList();
		expect(list.sessions.length).toBe(1);
		expect(list.sessions[0]!.agent).toBe("herdr:1/sh");
	});
});

describe("herdr bridge — lazy channels (R3)", () => {
	test("start() opens no control channel and issues no pane.focus (bare attach glances the board)", async () => {
		const { fake } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		expect(fake.state.children.length).toBe(0);
		// The bridge never touches herdr focus at bootstrap.
		expect(fake.state.requests.some((r) => r.method === "pane.focus")).toBe(false);
		expect(fake.state.requests.map((r) => r.method).sort()).toEqual([
			"events.subscribe",
			"ping",
			"session.snapshot",
		]);
	});

	test("resync before any focus re-emits the board and opens no channel", async () => {
		const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const listsBefore = c.of(MSG.SESSION_LIST).length;
		bridge.resync();
		expect(fake.state.children.length).toBe(0);
		expect(c.of(MSG.SESSION_LIST).length).toBe(listsBefore + 1);
	});

	test("FOCUS_SESSION opens the channel; its first (full) frame is the repaint", async () => {
		const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const child = focus(bridge, fake, 1);
		expect(child.paneId).toBe("w1:p1");
		child.frame("\x1b[2J\x1b[HSCREEN");
		expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 1)))).toBe("\x1b[2J\x1b[HSCREEN");
	});

	test("resync after a focus re-opens (repaints) the already-open channel", async () => {
		const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const first = focus(bridge, fake, 1);
		bridge.resync();
		expect(first.killed).toBe(true); // superseded by the repaint respawn
		expect(fake.state.children.length).toBe(2);
		expect(lastChild(fake).paneId).toBe("w1:p1");
	});

	test("focus switch spawns the new pane's channel; late bytes on the old channel are dropped (R3)", async () => {
		const { fake, c, bridge } = await startedBridge([
			{ pane_id: "w1:p1", focused: true },
			{ pane_id: "w1:p2" },
		]);
		const oldChild = focus(bridge, fake, 1);
		oldChild.frame("OLD-PANE-TAIL");
		const newChild = focus(bridge, fake, 2);
		expect(oldChild.killed).toBe(true);
		expect(newChild.paneId).toBe("w1:p2");
		// Bytes arriving on the superseded channel after the switch: dropped.
		const before2 = terminalHex(c.frames, 2);
		const before1 = terminalHex(c.frames, 1);
		oldChild.record({ type: "terminal.frame", seq: 9, full: false, width: 50, height: 24, encoding: "base64", bytes: Buffer.from("SMEAR").toString("base64") });
		expect(terminalHex(c.frames, 2)).toBe(before2);
		expect(terminalHex(c.frames, 1)).toBe(before1);
		// The new channel's first frame paints session 2.
		newChild.frame("NEW-PANE-SCREEN");
		expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 2)))).toBe("NEW-PANE-SCREEN");
	});

	test("focus on an unknown session id is dropped without a spawn", async () => {
		const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		bridge.route(MSG.FOCUS_SESSION, 0, { sessionId: 99 });
		expect(fake.state.children.length).toBe(0);
	});

	test("pre-bootstrap FOCUS and resync queue and flush once the snapshot resolves", async () => {
		const fake = fakeHerdr([{ pane_id: "w1:p1", focused: true }]);
		const c = collector();
		const bridge = new HerdrBridge({ runner: fake.runner, sink: c.sink, log: () => {} });
		bridge.start();
		bridge.resync(); // pre-bootstrap: must queue, not vanish
		bridge.route(MSG.FOCUS_SESSION, 0, { sessionId: 1 }); // queued too
		expect(fake.state.children.length).toBe(0);
		await Bun.sleep(1);
		// The queued FOCUS opened the channel after the snapshot committed id 1.
		expect(fake.state.children.length).toBe(1);
		expect(lastChild(fake).paneId).toBe("w1:p1");
	});
});

describe("herdr bridge — keystrokes & sizing", () => {
	test("keystroke hex for CR forwards as one base64 terminal.input on the focused channel", async () => {
		const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const child = focus(bridge, fake, 1);
		bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: "0d" });
		expect(child.writes).toEqual([
			JSON.stringify({ type: "terminal.input", bytes: Buffer.from("\r").toString("base64"), encoding: "base64" }),
		]);
	});

	test("mixed text+control payload (y + CR) and literal-with-newline keep byte order in one input", async () => {
		const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const child = focus(bridge, fake, 1);
		bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: toHex(new TextEncoder().encode("y\r")) });
		bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: toHex(new TextEncoder().encode("echo a\nls")) });
		const decoded = child.writes.map((w) => Buffer.from((JSON.parse(w) as { bytes: string }).bytes, "base64").toString());
		expect(decoded).toEqual(["y\r", "echo a\nls"]);
	});

	test("keystrokes for stale/unknown/non-focused sessions and invalid hex are dropped", async () => {
		const { fake, bridge } = await startedBridge([
			{ pane_id: "w1:p1", focused: true },
			{ pane_id: "w1:p2" },
		]);
		const child = focus(bridge, fake, 1);
		bridge.route(MSG.KEYSTROKE, 0, { sessionId: 99, hex: "0d" }); // unknown id
		bridge.route(MSG.KEYSTROKE, 0, { sessionId: 2, hex: "0d" }); // valid but not focused
		bridge.route(MSG.KEYSTROKE, 0, { sessionId: 1, hex: "zz" }); // invalid hex
		expect(child.writes).toEqual([]);
	});

	test("CLIENT_SIZE clamps out-of-range values, dedupes, resizes live channel, sizes new channels", async () => {
		const { fake, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const child = focus(bridge, fake, 1);
		expect([child.cols, child.rows]).toEqual([50, 24]); // default until a report arrives
		bridge.route(MSG.CLIENT_SIZE, 0, { cols: 0, rows: -3 });
		expect(child.writes).toContain(JSON.stringify({ type: "terminal.resize", cols: 10, rows: 5 }));
		bridge.route(MSG.CLIENT_SIZE, 0, { cols: 10, rows: 5 }); // duplicate after clamp: no-op
		expect(child.writes.filter((w) => w.includes("terminal.resize")).length).toBe(1);
		bridge.route(MSG.CLIENT_SIZE, 0, { cols: 40, rows: 20 });
		bridge.resync(); // respawn (channel already open) carries the current size
		expect([lastChild(fake).cols, lastChild(fake).rows]).toEqual([40, 20]);
	});
});

describe("herdr bridge — terminal stream", () => {
	test("an oversized terminal frame splits into multiple TERMINAL_DATA under the cap", async () => {
		const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const child = focus(bridge, fake, 1);
		const big = "x".repeat(40_000);
		child.frame(big);
		expect(c.of(MSG.TERMINAL_DATA).length).toBeGreaterThan(1);
		expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 1)))).toBe(big);
	});

	test("frame bytes have OSC sequences stripped before hitting the device", async () => {
		const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const child = focus(bridge, fake, 1);
		child.frame("\x1b[?25l\x1b[?2026h\x1b]8;;\x1b\\\x1b[2J\x1b[Hhello");
		expect(new TextDecoder().decode(fromHex(terminalHex(c.frames, 1)))).toBe("\x1b[?25l\x1b[?2026h\x1b[2J\x1b[Hhello");
	});

	test("takeover of the control channel surfaces as a device ERROR; a clean release stays silent", async () => {
		const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		const child = focus(bridge, fake, 1);
		child.record({ type: "terminal.closed", reason: "terminal attach taken over" });
		expect((c.of(MSG.ERROR)[0]!.payload as { message: string }).message).toContain("taken over");
		child.record({ type: "terminal.closed", reason: "detached" });
		expect(c.of(MSG.ERROR).length).toBe(1);
	});
});

describe("herdr bridge — alerts (per session)", () => {
	test("blocked emits exactly one attention; working/unknown emit none; re-block re-alerts", async () => {
		const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" });
		expect(c.alerts("attention").length).toBe(1);
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" }); // dup state
		expect(c.alerts("attention").length).toBe(1);
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "working" });
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "unknown" });
		expect(c.alerts("attention").length).toBe(1);
		expect(c.alerts("likely_done").length).toBe(0);
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" });
		expect(c.alerts("attention").length).toBe(2); // once per transition
	});

	test("done emits likely_done once and updates the board status", async () => {
		const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "done" });
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "done" });
		expect(c.alerts("likely_done").length).toBe(1);
		expect((c.of(MSG.SESSION_STATE).at(-1)!.payload as SessionSummary).status).toBe("done");
	});

	test("pane_exited emits session_ended once even if pane_closed follows", async () => {
		const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }, { pane_id: "w1:p2" }]);
		fake.push("pane_exited", { pane_id: "w1:p2", workspace_id: "w1" });
		fake.push("pane_closed", { pane_id: "w1:p2", workspace_id: "w1" });
		const ended = c.alerts("session_ended");
		expect(ended.length).toBe(1);
		expect((ended[0]!.payload as AlertSignalPayload).sessionId).toBe(2);
	});

	test("focused pane closing ends the stream and refreshes the board without auto-focusing", async () => {
		const { fake, c, bridge } = await startedBridge([
			{ pane_id: "w1:p1", focused: true },
			{ pane_id: "w1:p2" },
		]);
		const child = focus(bridge, fake, 1);
		const childCount = fake.state.children.length;
		fake.push("pane_exited", { pane_id: "w1:p1", workspace_id: "w1" });
		expect(child.killed).toBe(true);
		expect(fake.state.children.length).toBe(childCount); // no auto-spawn on another pane
		expect(c.lastList().sessions.map((s) => s.sessionId)).toEqual([2]);
		// Late keystrokes for the ended session are dropped.
		bridge.route(MSG.KEYSTROKE, 1, { sessionId: 1, hex: "0d" });
		expect(child.writes).toEqual([]);
	});

	test("reconnect resync re-emits attention for a still-blocked pane but not one back to working (R11)", async () => {
		const { fake, c, bridge } = await startedBridge([
			{ pane_id: "w1:p1", focused: true },
			{ pane_id: "w1:p2" },
		]);
		focus(bridge, fake, 1); // an open channel so the reconnect resync repaints
		fake.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "a", agent_status: "blocked" });
		fake.push("pane.agent_status_changed", { pane_id: "w1:p2", agent: "b", agent_status: "blocked" });
		fake.push("pane.agent_status_changed", { pane_id: "w1:p2", agent: "b", agent_status: "working" });
		expect(c.alerts("attention").length).toBe(2);
		// Device reconnect: start() re-emits the board, resync() re-derives alerts.
		bridge.start();
		bridge.resync();
		const attention = c.alerts("attention");
		expect(attention.length).toBe(3);
		expect((attention.at(-1)!.payload as AlertSignalPayload).sessionId).toBe(1);
		// And a repaint channel was (re)opened for the focused pane.
		expect(lastChild(fake).paneId).toBe("w1:p1");
	});

	test("pane_created triggers a resubscribe that covers the new pane's agent status", async () => {
		const { fake, c } = await startedBridge([{ pane_id: "w1:p1", focused: true }]);
		fake.push("pane_created", {
			pane: { pane_id: "w1:p9", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "unknown", agent: null, title: null },
		});
		await Bun.sleep(1);
		const subs = fake.currentSubs();
		expect(subs.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "w1:p9")).toBe(true);
		fake.push("pane.agent_status_changed", { pane_id: "w1:p9", agent: "codex", agent_status: "blocked" });
		expect(c.alerts("attention").length).toBe(1);
	});
});

describe("herdr bridge — single-target failure/retry", () => {
	test("daemon connection loss ends all sessions with ERROR and a later start() succeeds under fresh ids", async () => {
		const { fake, c, bridge } = await startedBridge([{ pane_id: "w1:p1", focused: true }, { pane_id: "w1:p2" }]);
		const child = focus(bridge, fake, 1);
		fake.dropSubscription();
		expect(c.alerts("session_ended").length).toBe(2);
		expect(c.of(MSG.ERROR).length).toBe(1);
		expect((c.of(MSG.ERROR)[0]!.payload as { message: string }).message).toContain("connection lost");
		expect(child.killed).toBe(true);
		// Daemon restarts with a fresh pane set; a new device ATTACH retries cleanly.
		fake.state.panes.splice(0, fake.state.panes.length, {
			pane_id: "w1:p1", terminal_id: "term_w1:p1", workspace_id: "w1", tab_id: "w1:t1",
			focused: true, agent_status: "unknown", agent: null, display_agent: null, title: null,
		});
		bridge.start();
		await Bun.sleep(1);
		// Fresh id (3): device session ids are never reused within a host process.
		expect(c.lastList().sessions.map((s) => s.sessionId)).toEqual([3]);
	});

	test("bootstrap failure (daemon absent) emits ERROR, no hang, and a retry works", async () => {
		const fake = fakeHerdr([{ pane_id: "w1:p1", focused: true }]);
		fake.state.failDial = true;
		const c = collector();
		const bridge = new HerdrBridge({ runner: fake.runner, sink: c.sink, log: () => {} });
		bridge.start();
		await Bun.sleep(1);
		expect((c.of(MSG.ERROR)[0]!.payload as { message: string }).message).toContain("herdr attach failed");
		expect(c.of(MSG.SESSION_STATE).length).toBe(0);
		fake.state.failDial = false;
		bridge.start();
		await Bun.sleep(1);
		expect(c.of(MSG.SESSION_STATE).length).toBe(1);
	});
});

describe("herdr bridge — multi-session (R1/R6)", () => {
	test("two daemons flatten into one board with session-prefixed labels", async () => {
		const { c } = await startedMulti({
			alpha: { panes: [{ pane_id: "w1:p1", agent: "claude", display_agent: "Claude", title: "a", agent_status: "working", focused: true }] },
			beta: { panes: [{ pane_id: "w1:p1", agent: "codex", display_agent: "Codex", title: "b", agent_status: "blocked", focused: true }] },
		});
		const list = c.lastList();
		expect(list.sessions.length).toBe(2);
		const labels = list.sessions.map((s) => s.agent).sort();
		// Both daemons expose pane "w1:p1"; the session prefix disambiguates them.
		expect(labels).toEqual(["alpha/herdr:1/a [claude]", "beta/herdr:1/b [codex]"]);
		// Enriched fields are NOT session-prefixed (only the legacy `agent` label is).
		expect(list.sessions.map((s) => s.kind).sort()).toEqual(["claude", "codex"]);
		// Distinct device ids per (session, pane).
		expect(new Set(list.sessions.map((s) => s.sessionId)).size).toBe(2);
	});

	test("FOCUS_SESSION opens the channel against the owning daemon; the other daemon stays untouched", async () => {
		const { h, c, bridge } = await startedMulti({
			alpha: { panes: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", focused: true }] },
			beta: { panes: [{ pane_id: "w1:p1", agent: "codex", agent_status: "blocked", focused: true }] },
		});
		expect(h.daemons.alpha!.state.children.length).toBe(0);
		expect(h.daemons.beta!.state.children.length).toBe(0);
		// Focus beta's row (session ids: alpha=1, beta=2 given sorted discovery order).
		const betaRow = c.lastList().sessions.find((s) => s.agent.startsWith("beta/"))!;
		bridge.route(MSG.FOCUS_SESSION, 0, { sessionId: betaRow.sessionId });
		expect(h.daemons.beta!.state.children.length).toBe(1);
		expect(h.daemons.alpha!.state.children.length).toBe(0);
		expect(h.daemons.beta!.state.children.at(-1)!.paneId).toBe("w1:p1");
	});

	test("daemon B unreachable at startup: A enumerates, one ERROR names B, a later refresh attaches B", async () => {
		const { h, c, bridge } = await startedMulti({
			alpha: { panes: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", focused: true }] },
			beta: { panes: [{ pane_id: "w1:p1", agent: "codex", agent_status: "blocked", focused: true }], failDial: true },
		});
		// A's board is up; exactly one ERROR, naming beta. With only one session
		// attached the label is unprefixed (prefix appears only when >1 is live).
		let list = c.lastList();
		expect(list.sessions.length).toBe(1);
		expect(list.sessions[0]!.kind).toBe("claude");
		expect(list.sessions[0]!.agent.startsWith("beta/")).toBe(false);
		const errs = c.of(MSG.ERROR);
		expect(errs.length).toBe(1);
		expect((errs[0]!.payload as { message: string }).message).toContain("(beta)");
		// beta comes back; the scheduled re-enumeration attaches it.
		h.daemons.beta!.state.failDial = false;
		await h.fireRefresh();
		list = c.lastList();
		expect(list.sessions.length).toBe(2);
		expect(list.sessions.some((s) => s.agent.startsWith("beta/"))).toBe(true);
		// Still just the one startup ERROR — the retry did not re-error.
		expect(c.of(MSG.ERROR).length).toBe(1);
	});

	test("post-attach drop of daemon A ends only A's panes; B stays live; a refresh re-attaches A under fresh ids", async () => {
		const { h, c, bridge } = await startedMulti({
			alpha: { panes: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", focused: true }] },
			beta: { panes: [{ pane_id: "w1:p1", agent: "codex", agent_status: "blocked", focused: true }] },
		});
		const before = c.lastList();
		const betaId = before.sessions.find((s) => s.agent.startsWith("beta/"))!.sessionId;
		const alphaId = before.sessions.find((s) => s.agent.startsWith("alpha/"))!.sessionId;
		// A's socket drops after attach.
		h.daemons.alpha!.dropSubscription();
		// Exactly one session_ended (A's single pane), naming A's device id.
		const ended = c.alerts("session_ended");
		expect(ended.length).toBe(1);
		expect((ended[0]!.payload as AlertSignalPayload).sessionId).toBe(alphaId);
		// ERROR names alpha; B's row survives the board rewrite.
		expect((c.of(MSG.ERROR).at(-1)!.payload as { message: string }).message).toContain("(alpha)");
		const afterDrop = c.lastList();
		expect(afterDrop.sessions.map((s) => s.sessionId)).toEqual([betaId]);
		// Re-enumeration re-attaches A under a NEW device id (ids never reused).
		await h.fireRefresh();
		const afterRefresh = c.lastList();
		expect(afterRefresh.sessions.some((s) => s.sessionId === betaId)).toBe(true); // B untouched
		const newAlpha = afterRefresh.sessions.find((s) => s.agent.startsWith("alpha/"))!;
		expect(newAlpha).toBeDefined();
		expect(newAlpha.sessionId).toBeGreaterThan(alphaId);
	});

	test("alerts and R11 re-derive are scoped per session across two daemons", async () => {
		const { h, c, bridge } = await startedMulti({
			alpha: { panes: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", focused: true }] },
			beta: { panes: [{ pane_id: "w1:p1", agent: "codex", agent_status: "working", focused: true }] },
		});
		h.daemons.alpha!.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" });
		h.daemons.beta!.push("pane.agent_status_changed", { pane_id: "w1:p1", agent: "codex", agent_status: "working" });
		expect(c.alerts("attention").length).toBe(1);
		// resync re-derives the one still-blocked pane (alpha), not beta.
		bridge.resync();
		const attention = c.alerts("attention");
		expect(attention.length).toBe(2);
		const alphaId = c.lastList().sessions.find((s) => s.agent.startsWith("alpha/"))!.sessionId;
		expect((attention.at(-1)!.payload as AlertSignalPayload).sessionId).toBe(alphaId);
	});
});
