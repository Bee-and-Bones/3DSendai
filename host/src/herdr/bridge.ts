// U4 (plan-005) HerdrBridge: the SessionBridge implementation that bridges
// herdr panes to the device. Structure/state ride the api socket (U3 client);
// terminal bytes ride a per-pane `herdr terminal session control` channel
// (U1 decision — NDJSON over pipes, no PTY): the first frame after (re)spawn
// is a full repaint, terminal.resize carries CLIENT_SIZE, and device
// keystroke hex forwards verbatim as base64 terminal.input.
//
// Device session = herdr pane. Only the focused pane holds a control channel,
// and output attribution is bound to the channel at spawn — bytes from a
// superseded channel are dropped, so old-pane output can never smear into a
// newly focused session (R3's repaint boundary, structurally).
//
// Alerts come from herdr's semantic agent states (R5): blocked -> attention,
// done -> likely_done, pane exit/close -> session_ended, once per transition.
// Device attach/reconnect re-derives pending alerts from current states (R11).
//
// Testability: the socket dial and the control-channel child are injected via
// a HerdrRunner seam, so unit tests run hermetically against fixture-fed
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

export interface HerdrBridgeOptions {
	runner: HerdrRunner;
	sink?: BridgeSink;
	/** Host-log seam for R9 warnings (default console.log). */
	log?: (msg: string) => void;
}

interface BridgeSession {
	id: number; // device-facing session id; never reused within a host process
	paneId: string;
	label: string;
	agent: string | undefined; // herdr-detected agent name, label enrichment
	agentStatus: string; // last herdr agent_status seen (dedupe boundary)
	ended: boolean;
}

const CAP = { streaming: true, liveApproval: false, interrupt: true };
const DEFAULT_SIZE = { cols: 50, rows: 24 };
const LABEL_MAX = 40;

/** herdr agent_status -> device SessionStatus. */
function deviceStatus(agentStatus: string): SessionStatus {
	switch (agentStatus) {
		case "working":
			return "running_tool";
		case "blocked":
			return "blocked";
		case "done":
			return "done";
		default:
			return "idle"; // idle / unknown / anything a newer daemon invents
	}
}

/** Alert class for a herdr agent-status transition; undefined = no alert. */
function alertFor(agentStatus: string): AlertClass | undefined {
	if (agentStatus === "blocked") return "attention";
	if (agentStatus === "done") return "likely_done";
	return undefined;
}

/**
 * Pane titles are process-controlled (terminal title escapes), not
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
	private readonly runner: HerdrRunner;
	private readonly client: HerdrClient;
	private sink: BridgeSink | undefined;
	private readonly log: (msg: string) => void;

	private readonly byId = new Map<number, BridgeSession>();
	private readonly byPane = new Map<string, BridgeSession>();
	private nextId = 1; // never reset: ids are never reused within a host process
	private focused: number | undefined;
	private clientSize: { cols: number; rows: number } | undefined;

	private phase: "idle" | "starting" | "ready" = "idle";
	private pendingOps: Array<() => void> = [];
	private sub: HerdrSubscription | undefined;
	private child: HerdrChild | undefined; // focused pane's control channel
	private tabLabels = new Map<string, string>();

	constructor(opts: HerdrBridgeOptions) {
		this.runner = opts.runner;
		this.client = createHerdrClient(opts.runner.dial);
		this.sink = opts.sink;
		this.log = opts.log ?? ((msg) => console.log(msg));
	}

	setSink(sink: BridgeSink | undefined): void {
		this.sink = sink;
	}

	/**
	 * Bootstrap against the daemon (ping/protocol gate, snapshot, subscribe) and
	 * emit the initial board. The SessionBridge contract is synchronous; the
	 * socket bootstrap runs async internally and resync()/route() calls arriving
	 * pre-bootstrap are queued and flushed once the snapshot applies. A
	 * bootstrap failure emits the R9 ERROR through the sink asynchronously and
	 * resets state so the next device ATTACH retries cleanly.
	 */
	start(): void {
		if (this.phase !== "idle") {
			if (this.phase === "ready") this.emitBoard();
			return;
		}
		this.phase = "starting";
		void this.bootstrap();
	}

	private async bootstrap(): Promise<void> {
		try {
			const boot = await bootstrapHerdr(this.client);
			for (const w of boot.warnings) this.log(`herdr: ${w}`);
			for (const t of boot.snapshot.tabs) this.tabLabels.set(t.tab_id, t.label ?? "");
			for (const p of boot.snapshot.panes) this.ensureSession(p);
			// Seed device focus from herdr's focused pane (first pane otherwise).
			// A focus left pointing at an ended session (daemon restart) re-seeds.
			const focusPane = boot.snapshot.focused_pane_id;
			const seed =
				(focusPane && this.byPane.get(focusPane)) || [...this.byId.values()].find((s) => !s.ended);
			const current = this.focused !== undefined ? this.byId.get(this.focused) : undefined;
			if ((!current || current.ended) && seed) this.focused = seed.id;
			await this.resubscribe();
			this.phase = "ready";
			this.emitBoard();
			const ops = this.pendingOps;
			this.pendingOps = [];
			for (const op of ops) op();
		} catch (err) {
			this.phase = "idle";
			this.pendingOps = [];
			this.emit(MSG.ERROR, 0, { message: `herdr attach failed: ${(err as Error).message}` });
		}
	}

	/**
	 * Open a subscribe connection covering the current pane set (global
	 * lifecycle + per-pane agent status). herdr accepts one subscribe per
	 * connection, so a pane-set change means a replacement connection: open the
	 * new one first, then end the old (no event gap; replays are deduped by
	 * pane bookkeeping and status-transition checks).
	 */
	private async resubscribe(): Promise<void> {
		const subs: unknown[] = [
			{ type: "pane.created" },
			{ type: "pane.closed" },
			{ type: "pane.exited" },
			{ type: "pane.agent_detected" },
		];
		for (const s of this.byId.values()) {
			if (!s.ended) subs.push({ type: "pane.agent_status_changed", pane_id: s.paneId });
		}
		const old = this.sub;
		this.sub = await this.client.subscribe(subs, {
			onEvent: (ev) => this.handleEvent(ev),
			onClose: () => this.onDaemonLost(),
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
		if (s && !s.ended) this.openChannel(s);
		// R11: a device that slept through an alert re-derives it from the
		// current agent states — once per attach, only for still-pending states.
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
		this.child?.kill();
		this.child = undefined;
		this.sub?.end();
		this.sub = undefined;
	}

	// --- internals ---

	/** (Re)spawn the control channel on a session's pane. */
	private openChannel(s: BridgeSession): void {
		this.child?.kill();
		const size = this.clientSize ?? DEFAULT_SIZE;
		let child: HerdrChild;
		try {
			child = this.runner.spawnControl(s.paneId, size.cols, size.rows);
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

	private handleEvent(ev: HerdrEvent): void {
		switch (ev.event) {
			// Global lifecycle pushes use underscored names; the per-pane
			// subscription uses the dotted name (fixtures README §3).
			case "pane_created": {
				const pane = ev.data.pane as HerdrPaneInfo | undefined;
				if (!pane || this.byPane.has(pane.pane_id)) return; // subscribe replay of a known pane
				this.ensureSession(pane);
				this.emitBoard();
				void this.resubscribe().catch(() => this.onDaemonLost());
				return;
			}
			case "pane_exited":
			case "pane_closed": {
				const paneId = ev.data.pane_id as string | undefined;
				const s = paneId ? this.byPane.get(paneId) : undefined;
				if (s && !s.ended) {
					this.endSession(s);
					this.emitBoard(); // the closed pane drops off the device board
				}
				return;
			}
			case "pane_agent_detected": {
				const s = this.byPane.get(ev.data.pane_id as string);
				if (s && typeof ev.data.agent === "string") {
					s.agent = ev.data.agent;
					this.emitState(s);
				}
				return;
			}
			case "pane.agent_status_changed": {
				const s = this.byPane.get(ev.data.pane_id as string);
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

	/** Daemon connection lost (socket EOF/restart): end everything, reset for retry. */
	private onDaemonLost(): void {
		for (const s of this.byId.values()) this.endSession(s);
		this.child?.kill();
		this.child = undefined;
		this.sub = undefined;
		this.phase = "idle"; // next device ATTACH retries start() cleanly
		this.emit(MSG.ERROR, 0, { message: "herdr daemon connection lost" });
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

	private ensureSession(p: HerdrPaneInfo): BridgeSession {
		// An ended entry under the same pane id is a previous daemon epoch (or a
		// reused pane id after restart): re-enumerate under a fresh device id.
		const existing = this.byPane.get(p.pane_id);
		if (existing && !existing.ended) return existing;
		const tab = this.tabLabels.get(p.tab_id) || p.tab_id;
		const title = p.title ?? p.agent ?? p.pane_id;
		const s: BridgeSession = {
			id: this.nextId++,
			paneId: p.pane_id,
			label: sanitizeLabel(`herdr:${tab}/${title}`),
			agent: p.agent ?? undefined,
			agentStatus: p.agent_status,
			ended: false,
		};
		this.byId.set(s.id, s);
		this.byPane.set(p.pane_id, s);
		if (this.focused === undefined) this.focused = s.id;
		return s;
	}

	private focusedSession(): BridgeSession | undefined {
		return this.focused !== undefined ? this.byId.get(this.focused) : undefined;
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
		return {
			sessionId: s.id,
			agent: s.agent ? `${s.label} [${sanitizeLabel(s.agent)}]` : s.label,
			cwd: "",
			status: deviceStatus(s.agentStatus),
			capability: CAP,
		};
	}

	private emit(type: number, sessionId: number, payload: unknown): void {
		this.sink?.(type, sessionId, payload);
	}
}
