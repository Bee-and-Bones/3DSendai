// U3 (plan-005) herdr socket client: speaks the herdr api socket's NDJSON
// protocol — one-shot request connections, long-lived subscribe connections —
// and runs the R9 bootstrap (ping/protocol check, session.snapshot capability
// check, event subscription).
//
// Connection model (observed on herdr 0.7.2, protocol 16 — the docs say
// otherwise; see host/test/fixtures/herdr/README.md): the daemon answers the
// FIRST request on a connection and immediately closes it. `events.subscribe`
// is the exception — its connection stays open and streams pushed events, but
// accepts exactly one subscribe request (a second one gets the connection
// dropped with no response). So request() dials per call and subscribe()
// dials a dedicated connection.
//
// Transport is injected (HerdrDial) so unit tests run hermetically against
// fixture-fed fakes; connectHerdrSocket() is the only live-socket code.

export const HERDR_PROTOCOL = 16;

/** One raw connection to the daemon. */
export interface HerdrConn {
	write(line: string): void;
	onData(listener: (bytes: Uint8Array) => void): void;
	onClose(listener: () => void): void;
	end(): void;
}

/** Opens a fresh connection; rejects if the socket is unreachable. */
export type HerdrDial = () => Promise<HerdrConn>;

export class HerdrError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export interface HerdrEvent {
	event: string;
	data: Record<string, unknown>;
}

export interface HerdrPingInfo {
	version: string;
	protocol: number;
}

export interface HerdrPaneInfo {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	focused: boolean;
	agent_status: string;
	agent?: string | null;
	title?: string | null;
}

export interface HerdrSnapshot {
	protocol: number;
	focused_pane_id?: string;
	workspaces: Array<{ workspace_id: string; label?: string | null }>;
	tabs: Array<{ tab_id: string; workspace_id: string; label?: string | null }>;
	panes: HerdrPaneInfo[];
}

export interface HerdrSubscription {
	end(): void;
}

export interface SubscribeHandlers {
	onEvent(ev: HerdrEvent): void;
	/** Fired once when the subscribe connection drops (daemon gone/restarted). */
	onClose(): void;
}

export interface HerdrClientOptions {
	/** Per-request timeout so a wedged daemon is an error, not a hang (R9). */
	timeoutMs?: number;
}

export interface HerdrClient {
	request(method: string, params: unknown): Promise<Record<string, unknown>>;
	subscribe(subscriptions: unknown[], handlers: SubscribeHandlers): Promise<HerdrSubscription>;
}

/** Split a byte stream into NDJSON lines, buffering partial lines. */
function lineSplitter(onLine: (line: string) => void): (bytes: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buf = "";
	return (bytes: Uint8Array) => {
		buf += decoder.decode(bytes, { stream: true });
		for (;;) {
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim()) onLine(line);
		}
	};
}

export function createHerdrClient(dial: HerdrDial, opts: HerdrClientOptions = {}): HerdrClient {
	const timeoutMs = opts.timeoutMs ?? 5000;
	let nextId = 1;

	return {
		async request(method: string, params: unknown): Promise<Record<string, unknown>> {
			const id = `req_${nextId++}`;
			const conn = await dial();
			return await new Promise((resolve, reject) => {
				let done = false;
				const finish = (fn: () => void) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					fn();
					conn.end();
				};
				const timer = setTimeout(
					() =>
						finish(() =>
							reject(new HerdrError("timeout", `herdr ${method}: no response in ${timeoutMs}ms`)),
						),
					timeoutMs,
				);
				conn.onData(
					lineSplitter((line) => {
						let msg: {
							id?: string;
							result?: Record<string, unknown>;
							error?: { code: string; message: string };
						};
						try {
							msg = JSON.parse(line);
						} catch {
							return; // not JSON — ignore; the timeout is the backstop
						}
						if (msg.id !== id) return; // stray line for another correlation id
						if (msg.error) {
							const e = msg.error;
							finish(() => reject(new HerdrError(e.code, e.message)));
						} else {
							finish(() => resolve(msg.result ?? {}));
						}
					}),
				);
				conn.onClose(() =>
					finish(() =>
						reject(new HerdrError("closed", `herdr ${method}: connection closed before response`)),
					),
				);
				conn.write(JSON.stringify({ id, method, params }) + "\n");
			});
		},

		async subscribe(
			subscriptions: unknown[],
			handlers: SubscribeHandlers,
		): Promise<HerdrSubscription> {
			const id = `sub_${nextId++}`;
			const conn = await dial();
			return await new Promise((resolve, reject) => {
				let acked = false;
				let closed = false;
				const timer = setTimeout(() => {
					if (acked) return;
					conn.end();
					reject(new HerdrError("timeout", `herdr events.subscribe: no ack in ${timeoutMs}ms`));
				}, timeoutMs);
				conn.onData(
					lineSplitter((line) => {
						let msg: {
							id?: string;
							event?: string;
							data?: Record<string, unknown>;
							error?: { code: string; message: string };
						};
						try {
							msg = JSON.parse(line);
						} catch {
							return;
						}
						if (!acked) {
							if (msg.id !== id) return;
							clearTimeout(timer);
							if (msg.error) {
								conn.end();
								reject(new HerdrError(msg.error.code, msg.error.message));
								return;
							}
							acked = true;
							resolve({
								end() {
									closed = true; // caller-initiated: suppress the onClose signal
									conn.end();
								},
							});
							return;
						}
						// Pushed events carry no id; discriminate on the `event` key.
						if (typeof msg.event === "string")
							handlers.onEvent({ event: msg.event, data: msg.data ?? {} });
					}),
				);
				conn.onClose(() => {
					clearTimeout(timer);
					if (!acked) {
						reject(
							new HerdrError("closed", "herdr events.subscribe: connection closed before ack"),
						);
						return;
					}
					if (!closed) {
						closed = true;
						handlers.onClose();
					}
				});
				conn.write(
					JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n",
				);
			});
		},
	};
}

// --- R9 bootstrap: ping/protocol gate + snapshot capability check ------------

/**
 * Fields the bridge reads from every snapshot pane. A newer daemon that
 * renamed any of these breaks the alert/session pipeline silently, so their
 * absence escalates to the R9 error path — "tolerate unknown fields" covers
 * additive changes only.
 */
function validatePane(p: Record<string, unknown>): p is Record<string, unknown> & HerdrPaneInfo {
	return (
		typeof p.pane_id === "string" &&
		typeof p.workspace_id === "string" &&
		typeof p.tab_id === "string" &&
		typeof p.agent_status === "string"
	);
}

export function parseSnapshot(result: Record<string, unknown>): HerdrSnapshot {
	const snap = result.snapshot as Record<string, unknown> | undefined;
	if (
		result.type !== "session_snapshot" ||
		!snap ||
		!Array.isArray(snap.panes) ||
		!Array.isArray(snap.workspaces) ||
		!Array.isArray(snap.tabs)
	) {
		throw new HerdrError(
			"bad_snapshot",
			"session.snapshot: response missing snapshot/panes — incompatible daemon",
		);
	}
	for (const p of snap.panes) {
		if (!validatePane(p as Record<string, unknown>)) {
			throw new HerdrError(
				"bad_snapshot",
				"session.snapshot: pane missing pane_id/workspace_id/tab_id/agent_status — incompatible daemon",
			);
		}
	}
	return {
		protocol: typeof snap.protocol === "number" ? snap.protocol : 0,
		focused_pane_id: typeof snap.focused_pane_id === "string" ? snap.focused_pane_id : undefined,
		workspaces: snap.workspaces as HerdrSnapshot["workspaces"],
		tabs: snap.tabs as HerdrSnapshot["tabs"],
		panes: snap.panes as HerdrPaneInfo[],
	};
}

export interface HerdrBootstrap {
	ping: HerdrPingInfo;
	snapshot: HerdrSnapshot;
	/** Non-fatal findings (e.g. newer daemon protocol) for the host log. */
	warnings: string[];
}

/**
 * Verify the daemon speaks a protocol we can drive, then snapshot. An older
 * protocol is fatal (no session.snapshot / terminal control channel); a newer
 * one is warn-and-continue gated on the snapshot carrying the exact fields the
 * bridge reads (R9). Subscription-type support is validated by the subscribe
 * call itself erroring.
 */
export async function bootstrapHerdr(client: HerdrClient): Promise<HerdrBootstrap> {
	const pong = await client.request("ping", {});
	const protocol = typeof pong.protocol === "number" ? pong.protocol : 0;
	const version = typeof pong.version === "string" ? pong.version : "unknown";
	if (protocol < HERDR_PROTOCOL) {
		throw new HerdrError(
			"protocol_too_old",
			`herdr daemon speaks protocol ${protocol} (${version}); need >= ${HERDR_PROTOCOL} (herdr >= 0.7.2)`,
		);
	}
	const warnings: string[] = [];
	if (protocol > HERDR_PROTOCOL) {
		warnings.push(
			`herdr daemon speaks protocol ${protocol} (${version}), newer than pinned ${HERDR_PROTOCOL}; continuing on capability check`,
		);
	}
	const snapshot = parseSnapshot(await client.request("session.snapshot", {}));
	return { ping: { version, protocol }, snapshot, warnings };
}

// --- live transport -----------------------------------------------------------

/** Live Bun.connect dial for a unix socket path. */
export function herdrDialer(socketPath: string): HerdrDial {
	return async () => {
		let onData: ((bytes: Uint8Array) => void) | undefined;
		let onClose: (() => void) | undefined;
		const socket = await Bun.connect({
			unix: socketPath,
			socket: {
				data(_s, chunk: Uint8Array) {
					onData?.(chunk);
				},
				close() {
					onClose?.();
				},
				error() {
					onClose?.();
				},
			},
		});
		return {
			write(line: string) {
				socket.write(line);
			},
			onData(listener) {
				onData = listener;
			},
			onClose(listener) {
				onClose = listener;
			},
			end() {
				socket.end();
			},
		};
	};
}
