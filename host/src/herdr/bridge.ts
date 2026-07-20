// U4 (plan 2026-07-20-001) HerdrBridge: the SessionBridge implementation that
// spans EVERY discovered herdr session and flattens their agent panes into one
// device board. Structure/state ride per-session api sockets (U3 client);
// terminal bytes ride a single per-focused-pane `herdr terminal session
// control` channel (U1 decision — NDJSON over pipes, no PTY).
//
// Multi-session model (supersedes the plan-005 single-daemon bridge):
//   - Discovery (U2) yields N attach targets; each becomes a SessionClient with
//     its own socket client + subscription and bootstraps INDEPENDENTLY. One
//     stale daemon emits one ERROR naming that session while the healthy subset
//     comes up; the failed session retries on the injected re-enumeration
//     schedule (R6). A back-compat single-target construction (an injected
//     HerdrRunner) keeps host/bin/host.ts compiling unchanged until U8 wires
//     discovery.
//   - Pane bookkeeping is keyed by (session, pane_id) -> device id; device ids
//     are never reused within a host process.
//   - Board enrichment ports agentslate's normalization (semantics only, MIT,
//     Daniel Ou — https://github.com/DanielOu1208/agentslate src/herdr.rs):
//     kind = pane `agent`; agentName = `display_agent` ?? `agent`; title =
//     `title` ?? `terminal_title_stripped` (absent at 0.7.3, tolerated); the
//     workspace label joined by workspace_id; the base set is panes[], enriched
//     from the snapshot's agent-bearing rows. All four fields pass sanitizeLabel
//     (control/escape strip + length cap) before SESSION_STATE emission — they
//     are process-controlled strings feeding the approval surface (R2). Labels
//     gain a `<session>/` prefix only when more than one session is attached.
//
// Terminal channels are LAZY (R3/KTD): no channel and no host-side pane.focus at
// bootstrap — attaching means glancing at the board. FOCUS_SESSION opens the
// channel (focus + spawn against the right daemon); resync() re-opens only a
// channel that was already open; a device that just wants the board never
// --takeover's or resizes a desktop pane. Output attribution is bound to the
// channel at spawn — bytes from a superseded channel are dropped (R3 repaint
// boundary, structurally).
//
// Alerts come from herdr's semantic agent states (R5), now per session: blocked
// -> attention, done -> likely_done, pane exit/close -> session_ended, once per
// transition. A daemon socket EOF after attach ends only that session's panes.
// Device attach/reconnect re-derives pending alerts from current states (R11).
//
// Testability: the socket dial and the control-channel child are injected via a
// HerdrRunner seam (single-target) or a makeRunner factory + discover/schedule
// seams (multi-session), so unit tests run hermetically against fixture-fed
// fakes (no live herdr).

import {
	type AlertClass,
	fromHex,
	MSG,
	type SessionStatus,
	type SessionSummary,
	type TerminalDataPayload,
	toHex,
} from "@agentbus/protocol";
import {
	type BridgeSink,
	clampSize,
	type SessionBridge,
	splitTerminalHex,
} from "../tmux/bridge.ts";
import type { HerdrTarget } from "./discovery.ts";
import {
	bootstrapHerdr,
	createHerdrClient,
	type HerdrClient,
	type HerdrDial,
	type HerdrEvent,
	type HerdrPaneInfo,
	type HerdrSubscription,
} from "./socket.ts";

/** One live `herdr terminal session control` child (NDJSON over pipes). */
export interface HerdrChild {
	onData(listener: (bytes: Uint8Array) => void): void;
	/** The child process exited (channel gone). */
	onExit(listener: () => void): void;
	/** Write one NDJSON command line (terminal.input / terminal.resize / ...). */
	write(line: string): void;
	kill(): void;
}

/** The herdr process/socket seam. Injected so unit tests don't need herdr. */
export interface HerdrRunner {
	/** Socket transport for the api socket (U3 client dials per request). */
	dial: HerdrDial;
	/** Spawn a control channel on a pane, sized and with takeover authority. */
	spawnControl(paneId: string, cols: number, rows: number): HerdrChild;
}

/** Per-target runner factory for the multi-session bridge (U4). */
export type MakeRunner = (target: HerdrTarget) => HerdrRunner;

/** Opaque timer handle from the injected re-enumeration scheduler. */
export type TimerHandle = unknown;

export interface HerdrBridgeOptions {
	/**
	 * Back-compat single-target construction: one already-built runner drives one
	 * (unnamed) session. Discovery is disabled. host/bin/host.ts uses this until
	 * U8 wires multi-session discovery.
	 */
	runner?: HerdrRunner;
	/** Multi-session: build a runner per discovered target. */
	makeRunner?: MakeRunner;
	/** Multi-session: enumerate the current attach targets. */
	discover?: () => Promise<HerdrTarget[]>;
	/** Multi-session: schedule the next re-enumeration (default setTimeout). */
	schedule?: (fn: () => void, ms: number) => TimerHandle;
	/** Multi-session: cancel a scheduled re-enumeration (default clearTimeout). */
	cancel?: (handle: TimerHandle) => void;
	/** Re-enumeration interval in ms (default 5000). */
	refreshMs?: number;
	sink?: BridgeSink;
	/** Host-log seam for R9 warnings (default console.log). */
	log?: (msg: string) => void;
}

/** A pane row carrying the optional enrichment fields the snapshot inlines. */
interface RawPane extends HerdrPaneInfo {
	display_agent?: string | null;
	terminal_title_stripped?: string | null;
}

/** One attached herdr daemon: its socket client, subscription, and labels. */
interface SessionClient {
	name: string; // herdr session name; "" for the back-compat single target
	runner: HerdrRunner;
	client: HerdrClient;
	sub: HerdrSubscription | undefined;
	phase: "starting" | "ready" | "failed";
	tabLabels: Map<string, string>;
	workspaceLabels: Map<string, string>;
	focusedPaneHint: string | undefined;
}

interface BridgeSession {
	id: number; // device-facing session id; never reused within a host process
	sessionName: string; // owning herdr session
	paneId: string;
	label: string; // legacy decorated tab/title label, pre session-prefix
	agent: string; // raw herdr `agent` (kind source + legacy decoration)
	displayAgent: string; // raw `display_agent` (agentName source)
	titleRaw: string; // raw title / terminal_title_stripped
	workspace: string; // sanitized workspace label (snapshot-derived)
	agentStatus: string; // last herdr agent_status seen (dedupe boundary)
	ended: boolean;
}

const CAP = { streaming: true, liveApproval: false, interrupt: true };
const DEFAULT_SIZE = { cols: 50, rows: 24 };
const LABEL_MAX = 40;

/** Composite (session, pane) key so pane ids can collide across daemons. */
function paneKey(sessionName: string, paneId: string): string {
	return `${sessionName}\u0000${paneId}`;
}

/**
 * herdr agent_status -> device SessionStatus (R2). Recognized states map
 * explicitly; anything a newer daemon invents (and herdr's own agentless
 * "unknown") falls through to the U3 "unknown" union member.
 */
function deviceStatus(agentStatus: string): SessionStatus {
	switch (agentStatus) {
		case "working":
			return "running_tool";
		case "blocked":
			return "blocked";
		case "done":
			return "done";
		case "idle":
			return "idle";
		default:
			return "unknown";
	}
}

/** Alert class for a herdr agent-status transition; undefined = no alert. */
function alertFor(agentStatus: string): AlertClass | undefined {
	if (agentStatus === "blocked") return "attention";
	if (agentStatus === "done") return "likely_done";
	return undefined;
}

/**
 * Pane titles/agent names are process-controlled (terminal title escapes), not
 * operator-chosen: strip control/escape bytes and truncate before the label
 * reaches the device.
 */
export function sanitizeLabel(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		if (c < 0x20 || c === 0x7f) continue;
		out += ch;
		if (out.length >= LABEL_MAX) break;
	}
	return out;
}

/**
 * Strip OSC sequences (ESC ] ... BEL | ESC \) from terminal bytes. Every herdr
 * frame opens with OSC 8; the device term.c does not parse OSC and would spill
 * its body as printable text, so the bridge removes them host-side.
 */
export function stripOsc(bytes: Uint8Array): Uint8Array {
	const out: Uint8Array = new Uint8Array(bytes.length);
	let n = 0;
	let i = 0;
	while (i < bytes.length) {
		if (bytes[i] === 0x1b && bytes[i + 1] === 0x5d) {
			// inside OSC: consume until BEL or ST (ESC \), or end of chunk
			i += 2;
			while (i < bytes.length) {
				if (bytes[i] === 0x07) {
					i += 1;
					break;
				}
				if (bytes[i] === 0x1b && bytes[i + 1] === 0x5c) {
					i += 2;
					break;
				}
				i += 1;
			}
			continue;
		}
		out[n++] = bytes[i]!;
		i += 1;
	}
	return out.subarray(0, n);
}

export class HerdrBridge implements SessionBridge {
	private readonly singleRunner: HerdrRunner | undefined;
	private readonly makeRunner: MakeRunner | undefined;
	private readonly discover: (() => Promise<HerdrTarget[]>) | undefined;
	private readonly schedule: (fn: () => void, ms: number) => TimerHandle;
	private readonly cancel: (handle: TimerHandle) => void;
	private readonly refreshMs: number;
	private sink: BridgeSink | undefined;
	private readonly log: (msg: string) => void;

	private readonly sessions = new Map<string, SessionClient>();
	private readonly byId = new Map<number, BridgeSession>();
	private readonly byKey = new Map<string, BridgeSession>();
	private nextId = 1; // never reset: ids are never reused within a host process
	private focused: number | undefined;
	private clientSize: { cols: number; rows: number } | undefined;

	private phase: "idle" | "starting" | "ready" = "idle";
	private pendingOps: Array<() => void> = [];
	private child: HerdrChild | undefined; // the single focused pane's control channel
	private refreshHandle: TimerHandle | undefined;
	private disposed = false;

	constructor(opts: HerdrBridgeOptions) {
		this.singleRunner = opts.runner;
		this.makeRunner = opts.makeRunner;
		this.discover = opts.discover;
		if (!this.singleRunner && !(this.makeRunner && this.discover)) {
			throw new Error(
				"HerdrBridge: provide either a single-target runner or makeRunner + discover",
			);
		}
		this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.refreshMs = opts.refreshMs ?? 5000;
		this.sink = opts.sink;
		this.log = opts.log ?? ((msg) => console.log(msg));
	}

	setSink(sink: BridgeSink | undefined): void {
		this.sink = sink;
	}

	/**
	 * Bootstrap every attach target (ping/protocol gate, snapshot, subscribe) and
	 * emit the flattened board. The SessionBridge contract is synchronous; the
	 * socket bootstraps run async internally and resync()/route() calls arriving
	 * pre-bootstrap are queued and flushed once the initial enumeration settles.
	 * A total bootstrap failure (single-target, or discovery itself failing)
	 * emits an ERROR through the sink and resets so the next device ATTACH retries
	 * cleanly; a partial multi-session failure comes up with the healthy subset.
	 */
	start(): void {
		if (this.phase !== "idle") {
			if (this.phase === "ready") this.emitBoard();
			return;
		}
		this.phase = "starting";
		void this.bootstrapAll();
	}

	private async bootstrapAll(): Promise<void> {
		let targets: HerdrTarget[];
		if (this.singleRunner) {
			// Sentinel target: the single runner ignores it.
			targets = [{ session: undefined, socketPath: "" }];
		} else {
			try {
				targets = await this.discover!();
			} catch (err) {
				this.phase = "idle";
				this.pendingOps = [];
				this.emit(MSG.ERROR, 0, {
					message: `herdr discovery failed: ${(err as Error).message}`,
				});
				return;
			}
		}

		const clients = targets.map((t) => this.ensureClient(t));
		await Promise.all(clients.map((sc) => this.bootstrapSession(sc)));

		if (this.singleRunner && this.attachedCount() === 0) {
			// Single-target with the one daemon down: mirror the pre-refactor retry
			// contract — ERROR already emitted, reset to idle for the next ATTACH.
			this.phase = "idle";
			this.pendingOps = [];
			return;
		}

		this.seedFocus();
		this.phase = "ready";
		this.emitBoard();
		this.armRefresh();
		const ops = this.pendingOps;
		this.pendingOps = [];
		for (const op of ops) op();
	}

	/** Get-or-(re)create the SessionClient for a target, keyed by session name. */
	private ensureClient(target: HerdrTarget): SessionClient {
		const name = target.session ?? "";
		const existing = this.sessions.get(name);
		if (existing && existing.phase === "ready") return existing;
		const runner = this.singleRunner ?? this.makeRunner!(target);
		const sc: SessionClient = {
			name,
			runner,
			client: createHerdrClient(runner.dial),
			sub: undefined,
			phase: "starting",
			tabLabels: new Map(),
			workspaceLabels: new Map(),
			focusedPaneHint: undefined,
		};
		this.sessions.set(name, sc);
		return sc;
	}

	/**
	 * Bootstrap one session: ping/protocol gate, snapshot, subscribe, commit
	 * panes. On failure emit one ERROR naming the session and drop any panes
	 * created for it — the other sessions are untouched (R6). Panes are committed
	 * only after the snapshot succeeds, so a dial/ping failure creates nothing.
	 */
	private async bootstrapSession(sc: SessionClient): Promise<void> {
		sc.phase = "starting";
		try {
			const boot = await bootstrapHerdr(sc.client);
			for (const w of boot.warnings) this.log(`herdr${this.tag(sc)}: ${w}`);
			for (const t of boot.snapshot.tabs) sc.tabLabels.set(t.tab_id, t.label ?? "");
			for (const w of boot.snapshot.workspaces)
				sc.workspaceLabels.set(w.workspace_id, w.label ?? "");
			for (const p of boot.snapshot.panes) this.ensureSession(sc, p as RawPane);
			sc.focusedPaneHint = boot.snapshot.focused_pane_id;
			await this.resubscribeSession(sc);
			sc.phase = "ready";
		} catch (err) {
			sc.phase = "failed";
			this.dropSessionPanes(sc);
			sc.sub?.end();
			sc.sub = undefined;
			this.emit(MSG.ERROR, 0, {
				message: `herdr attach failed${this.tag(sc)}: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * (Re)open a subscribe connection for one session covering its current pane
	 * set (global lifecycle + per-pane agent status). herdr accepts one subscribe
	 * per connection, so a pane-set change means a replacement connection: open
	 * the new one first, then end the old.
	 */
	private async resubscribeSession(sc: SessionClient): Promise<void> {
		const subs: unknown[] = [
			{ type: "pane.created" },
			{ type: "pane.closed" },
			{ type: "pane.exited" },
			{ type: "pane.agent_detected" },
		];
		for (const s of this.byId.values()) {
			if (s.sessionName === sc.name && !s.ended)
				subs.push({ type: "pane.agent_status_changed", pane_id: s.paneId });
		}
		const old = sc.sub;
		sc.sub = await sc.client.subscribe(subs, {
			onEvent: (ev) => this.handleEvent(sc, ev),
			onClose: () => this.onDaemonLost(sc),
		});
		old?.end();
	}

	/** Repaint the focused (or given) session and re-derive pending alerts (R11). */
	resync(sessionId?: number): void {
		if (this.phase !== "ready") {
			if (this.phase === "starting") this.pendingOps.push(() => this.resync(sessionId));
			return;
		}
		const s = sessionId !== undefined ? this.byId.get(sessionId) : this.focusedSession();
		// Re-open only a channel that was already open (never --takeover on a bare
		// board glance): a resync with a live terminal repaints it; a board-glance
		// resync (no open channel) re-emits the board and opens nothing.
		if (s && !s.ended && this.child) this.openChannel(s);
		else this.emitBoard();
		// R11: a device that slept through an alert re-derives it from the current
		// agent states — once per attach, only for still-pending states.
		for (const sess of this.byId.values()) {
			if (sess.ended) continue;
			const cls = alertFor(sess.agentStatus);
			if (cls) this.emit(MSG.ALERT_SIGNAL, sess.id, { sessionId: sess.id, class: cls });
		}
	}

	/** Route an inbound device frame (KEYSTROKE, FOCUS_SESSION, CLIENT_SIZE). */
	route(type: number, sessionId: number, payload: unknown): void {
		if (this.phase !== "ready") {
			if (this.phase === "starting")
				this.pendingOps.push(() => this.route(type, sessionId, payload));
			return;
		}
		if (type === MSG.FOCUS_SESSION) {
			const target = (payload as { sessionId: number }).sessionId;
			const s = this.byId.get(target);
			if (!s || s.ended) return; // unknown/stale ids are dropped
			this.focused = target;
			this.openChannel(s); // first frame after spawn is the full repaint (R3)
			return;
		}
		if (type === MSG.KEYSTROKE) {
			const p = payload as { sessionId: number; hex: string };
			const s = this.byId.get(p.sessionId || (this.focused ?? -1));
			if (!s || s.ended || s.id !== this.focused || !this.child) return;
			// fromHex is lenient; validate at the device boundary so malformed hex
			// is rejected rather than decoded into surprise bytes.
			if (typeof p.hex !== "string" || p.hex.length === 0 || !/^([0-9a-fA-F]{2})+$/.test(p.hex))
				return;
			const bytes: Uint8Array = fromHex(p.hex);
			// Verbatim: text and control bytes ride one ordered channel (U1 §7).
			this.child.write(
				JSON.stringify({
					type: "terminal.input",
					bytes: Buffer.from(bytes).toString("base64"),
					encoding: "base64",
				}),
			);
			return;
		}
		if (type === MSG.CLIENT_SIZE) {
			const p = payload as { cols: number; rows: number };
			const size = clampSize(p.cols, p.rows);
			if (size.cols === this.clientSize?.cols && size.rows === this.clientSize?.rows) return;
			this.clientSize = size;
			this.child?.write(
				JSON.stringify({ type: "terminal.resize", cols: size.cols, rows: size.rows }),
			);
		}
	}

	stop(): void {
		this.disposed = true;
		this.child?.kill();
		this.child = undefined;
		for (const sc of this.sessions.values()) {
			sc.sub?.end();
			sc.sub = undefined;
		}
		if (this.refreshHandle !== undefined) {
			this.cancel(this.refreshHandle);
			this.refreshHandle = undefined;
		}
	}

	// --- internals ---

	/** Arm the next re-enumeration tick (multi-session only). */
	private armRefresh(): void {
		if (this.singleRunner || this.disposed) return;
		this.refreshHandle = this.schedule(() => {
			void this.doRefresh();
		}, this.refreshMs);
	}

	/**
	 * Re-enumerate: attach any target that has no ready session (a startup
	 * failure now reachable, or a daemon that dropped after attach), then re-arm.
	 * A discovery error keeps the current set and re-arms for the next tick.
	 */
	private async doRefresh(): Promise<void> {
		if (this.disposed) return;
		if (this.phase !== "ready") {
			this.armRefresh();
			return;
		}
		let targets: HerdrTarget[];
		try {
			targets = await this.discover!();
		} catch (err) {
			this.log(`herdr discovery: ${(err as Error).message}`);
			this.armRefresh();
			return;
		}
		if (this.disposed) return;
		const toBoot: SessionClient[] = [];
		for (const t of targets) {
			const name = t.session ?? "";
			const existing = this.sessions.get(name);
			if (existing && existing.phase === "ready") continue;
			toBoot.push(this.ensureClient(t));
		}
		if (toBoot.length > 0) {
			await Promise.all(toBoot.map((sc) => this.bootstrapSession(sc)));
			this.seedFocus();
			this.emitBoard();
		}
		this.armRefresh();
	}

	/** (Re)spawn the control channel on a session's pane, via its own runner. */
	private openChannel(s: BridgeSession): void {
		const sc = this.sessions.get(s.sessionName);
		if (!sc) return;
		this.child?.kill();
		const size = this.clientSize ?? DEFAULT_SIZE;
		let child: HerdrChild;
		try {
			child = sc.runner.spawnControl(s.paneId, size.cols, size.rows);
		} catch (err) {
			this.child = undefined;
			this.emit(MSG.ERROR, s.id, {
				message: `herdr control channel failed: ${(err as Error).message}`,
			});
			return;
		}
		this.child = child;
		let buf = "";
		const decoder = new TextDecoder();
		child.onData((bytes) => {
			// Attribution is bound to this channel: if a focus switch superseded it,
			// late bytes are dropped, never painted into the new session (R3).
			if (this.child !== child) return;
			buf += decoder.decode(bytes, { stream: true });
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) this.handleControlRecord(s, line);
			}
		});
		child.onExit(() => {
			if (this.child === child) this.child = undefined;
		});
	}

	private handleControlRecord(s: BridgeSession, line: string): void {
		let rec: { type?: string; bytes?: string; reason?: string };
		try {
			rec = JSON.parse(line);
		} catch {
			return;
		}
		if (rec.type === "terminal.frame" && typeof rec.bytes === "string") {
			const raw: Uint8Array = new Uint8Array(Buffer.from(rec.bytes, "base64"));
			const cleaned = stripOsc(raw);
			if (cleaned.length === 0) return;
			for (const hex of splitTerminalHex(s.id, toHex(cleaned))) {
				this.emit(MSG.TERMINAL_DATA, s.id, { sessionId: s.id, hex } satisfies TerminalDataPayload);
			}
			return;
		}
		if (rec.type === "terminal.closed") {
			const reason = rec.reason ?? "";
			// "detached" is a self-release; a dying pane surfaces via pane_exited.
			// Takeover/attach failures are real errors the user should see.
			if (reason.includes("taken over") || reason.includes("attach failed")) {
				this.emit(MSG.ERROR, s.id, { message: `herdr terminal channel closed: ${reason}` });
			}
		}
	}

	private handleEvent(sc: SessionClient, ev: HerdrEvent): void {
		switch (ev.event) {
			// Global lifecycle pushes use underscored names; the per-pane
			// subscription uses the dotted name (fixtures README §3).
			case "pane_created": {
				const pane = ev.data.pane as RawPane | undefined;
				if (!pane || this.byKey.has(paneKey(sc.name, pane.pane_id))) return; // replay of a known pane
				this.ensureSession(sc, pane);
				this.emitBoard();
				void this.resubscribeSession(sc).catch(() => this.onDaemonLost(sc));
				return;
			}
			case "pane_exited":
			case "pane_closed": {
				const paneId = ev.data.pane_id as string | undefined;
				const s = paneId ? this.byKey.get(paneKey(sc.name, paneId)) : undefined;
				if (s && !s.ended) {
					this.endSession(s);
					this.emitBoard(); // the closed pane drops off the device board
				}
				return;
			}
			case "pane_agent_detected": {
				const s = this.byKey.get(paneKey(sc.name, ev.data.pane_id as string));
				if (s && typeof ev.data.agent === "string") {
					s.agent = ev.data.agent;
					this.emitState(s);
				}
				return;
			}
			case "pane.agent_status_changed": {
				const s = this.byKey.get(paneKey(sc.name, ev.data.pane_id as string));
				const status = ev.data.agent_status;
				if (!s || s.ended || typeof status !== "string") return;
				if (typeof ev.data.agent === "string") s.agent = ev.data.agent;
				if (status === s.agentStatus) return; // dedupe: once per transition
				s.agentStatus = status;
				this.emitState(s);
				const cls = alertFor(status);
				if (cls) this.emit(MSG.ALERT_SIGNAL, s.id, { sessionId: s.id, class: cls });
				return;
			}
			default:
				return; // tolerate unknown event kinds (additive daemon changes)
		}
	}

	/**
	 * One daemon's connection lost (socket EOF/restart): end only THIS session's
	 * panes (R6 isolation), tear down its subscription, mark it failed. In
	 * single-target mode reset to idle so the next device ATTACH retries; in
	 * multi-session mode the re-enumeration schedule re-attaches it later.
	 */
	private onDaemonLost(sc: SessionClient): void {
		for (const s of this.byId.values()) {
			if (s.sessionName === sc.name) this.endSession(s);
		}
		sc.sub = undefined;
		sc.phase = "failed";
		this.emit(MSG.ERROR, 0, { message: `herdr daemon connection lost${this.tag(sc)}` });
		if (this.singleRunner) {
			this.child?.kill();
			this.child = undefined;
			this.sessions.delete(sc.name);
			this.phase = "idle"; // next device ATTACH retries start() cleanly
			return;
		}
		this.emitBoard(); // board drops this daemon's rows; refresh re-attaches later
	}

	private endSession(s: BridgeSession): void {
		if (s.ended) return;
		s.ended = true;
		this.emit(MSG.ALERT_SIGNAL, s.id, {
			sessionId: s.id,
			class: "session_ended" satisfies AlertClass,
		});
		if (this.focused === s.id) {
			// Never auto-focus a pane the user didn't choose: stop the stream, show
			// the fresh board, and wait for the device to pick.
			this.child?.kill();
			this.child = undefined;
		}
	}

	/** Delete a session's panes without emitting (a never-committed bootstrap). */
	private dropSessionPanes(sc: SessionClient): void {
		for (const [id, s] of [...this.byId]) {
			if (s.sessionName !== sc.name) continue;
			this.byId.delete(id);
			this.byKey.delete(paneKey(sc.name, s.paneId));
			if (this.focused === id) {
				this.child?.kill();
				this.child = undefined;
				this.focused = undefined;
			}
		}
	}

	private ensureSession(sc: SessionClient, p: RawPane): BridgeSession {
		// An ended entry under the same (session, pane id) is a previous daemon
		// epoch (or a reused pane id after restart): re-enumerate under a fresh id.
		const key = paneKey(sc.name, p.pane_id);
		const existing = this.byKey.get(key);
		if (existing && !existing.ended) return existing;
		const tab = sc.tabLabels.get(p.tab_id) || p.tab_id;
		// Legacy decorated label matches the pre-refactor shape exactly (old
		// clients still parse `agent`): herdr:<tab>/<title|agent|pane_id>.
		const legacyTitle = p.title ?? p.agent ?? p.pane_id;
		const s: BridgeSession = {
			id: this.nextId++,
			sessionName: sc.name,
			paneId: p.pane_id,
			label: sanitizeLabel(`herdr:${tab}/${legacyTitle}`),
			agent: typeof p.agent === "string" ? p.agent : "",
			displayAgent: typeof p.display_agent === "string" ? p.display_agent : "",
			titleRaw:
				typeof p.title === "string"
					? p.title
					: typeof p.terminal_title_stripped === "string"
						? p.terminal_title_stripped
						: "",
			workspace: sanitizeLabel(sc.workspaceLabels.get(p.workspace_id) ?? ""),
			agentStatus: typeof p.agent_status === "string" ? p.agent_status : "unknown",
			ended: false,
		};
		this.byId.set(s.id, s);
		this.byKey.set(key, s);
		if (this.focused === undefined) this.focused = s.id;
		return s;
	}

	/** Seed device focus from a session's focused pane, else the first live pane. */
	private seedFocus(): void {
		const current = this.focused !== undefined ? this.byId.get(this.focused) : undefined;
		if (current && !current.ended) return;
		for (const sc of this.sessions.values()) {
			if (!sc.focusedPaneHint) continue;
			const s = this.byKey.get(paneKey(sc.name, sc.focusedPaneHint));
			if (s && !s.ended) {
				this.focused = s.id;
				return;
			}
		}
		const first = [...this.byId.values()].find((s) => !s.ended);
		this.focused = first?.id;
	}

	private focusedSession(): BridgeSession | undefined {
		return this.focused !== undefined ? this.byId.get(this.focused) : undefined;
	}

	/** Number of daemons currently attached (drives the label session-prefix). */
	private attachedCount(): number {
		let n = 0;
		for (const sc of this.sessions.values()) if (sc.phase === "ready") n += 1;
		return n;
	}

	private tag(sc: SessionClient): string {
		return sc.name ? ` (${sc.name})` : "";
	}

	private emitBoard(): void {
		for (const s of this.byId.values()) {
			if (!s.ended) this.emitState(s);
		}
		this.emit(MSG.SESSION_LIST, 0, { sessions: this.list() });
	}

	private emitState(s: BridgeSession): void {
		this.emit(MSG.SESSION_STATE, s.id, this.summary(s));
	}

	private list(): SessionSummary[] {
		return [...this.byId.values()].filter((s) => !s.ended).map((s) => this.summary(s));
	}

	private summary(s: BridgeSession): SessionSummary {
		const kind = sanitizeLabel(s.agent);
		const agentName = sanitizeLabel(s.displayAgent || s.agent);
		const title = sanitizeLabel(s.titleRaw);
		const workspace = s.workspace;
		const prefix = this.attachedCount() > 1 ? `${sanitizeLabel(s.sessionName)}/` : "";
		const decorated = kind ? `${s.label} [${kind}]` : s.label;
		const summary: SessionSummary = {
			sessionId: s.id,
			agent: prefix + decorated,
			cwd: "",
			status: deviceStatus(s.agentStatus),
			capability: CAP,
		};
		if (kind) summary.kind = kind;
		if (agentName) summary.agentName = agentName;
		if (title) summary.title = title;
		if (workspace) summary.workspace = workspace;
		return summary;
	}

	private emit(type: number, sessionId: number, payload: unknown): void {
		this.sink?.(type, sessionId, payload);
	}
}
