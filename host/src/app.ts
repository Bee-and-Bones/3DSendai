// Host composition: wires the token-gated server to the session source, and
// serves reconnect replay. This is the M1/M2 application seam (U6/U7/U18).
//
// The session source is either the SessionRegistry (agent adapters, default) or
// a SessionBridge (U31 terminal mode; U2 plan-005 names the seam as an
// interface so tmux and herdr backends interchange). The bridge is a leaner
// source: bridge sessions aren't Adapters, so bridge frames route straight
// through conn.send and inbound KEYSTROKE/FOCUS_SESSION frames go to
// bridge.route — no registry multiplexing.

import { MSG, toHex } from "@agentbus/protocol";
import type { Adapter } from "./adapters/interface.ts";
import type { Stt } from "./audio/stt.ts";
import { VoiceRoute } from "./audio/voice.ts";
import { SessionRegistry } from "./registry/index.ts";
import { createServer, type RunningServer, type ServerConfig } from "./server/index.ts";
import type { SessionBridge } from "./tmux/bridge.ts";

export interface HostApp {
	readonly registry: SessionRegistry;
	readonly port: number;
	createSession(agent: string, cwd: string, adapter: Adapter): number;
	stop(): void;
}

export interface HostOptions {
	/** When set, the bridge is the session source instead of agent adapters (U31). */
	bridge?: SessionBridge;
	/** U12: STT backend for push-to-talk. Unset => AUDIO_CHUNK frames are ignored. */
	stt?: Stt;
}

export async function createHost(
	config: ServerConfig,
	options: HostOptions = {},
): Promise<HostApp> {
	const registry = new SessionRegistry();
	const bridge = options.bridge;

	// U12 voice path: transcribe a finished utterance and inject it into the
	// pane through the bridge's send-keys path (text as UTF-8 key bytes, no
	// trailing Enter — the user confirms on-device). Echoes the final
	// transcript back to the device as TRANSCRIPT_PARTIAL.
	let echo: ((sessionId: number, text: string) => void) | undefined;
	const voice =
		options.stt && bridge
			? new VoiceRoute({
					stt: options.stt,
					inject: (sessionId, text) =>
						bridge.route(MSG.KEYSTROKE, sessionId, {
							sessionId,
							hex: toHex(new TextEncoder().encode(text)),
						}),
					echo: (sessionId, text) => echo?.(sessionId, text),
				})
			: undefined;

	const server: RunningServer = await createServer(config, {
		onAttach(payload, conn) {
			if (bridge) {
				// Terminal mode: the bridge streams straight to this connection. Last
				// ATTACH wins (single-device scope). Seed the focused pane (KTD3).
				bridge.setSink((type, sessionId, p) => conn.send(type, sessionId, p));
				echo = (sessionId, text) =>
					conn.send(MSG.TRANSCRIPT_PARTIAL, sessionId, { text, final: true });
				bridge.start();
				bridge.resync();
				return;
			}
			// Bind the registry's output to this connection.
			registry.setSink((type, sessionId, p) => conn.send(type, sessionId, p));
			const cursor = (payload as { cursor?: number } | null)?.cursor;
			if (typeof cursor === "number") {
				// Reconnect: replay everything produced after the cursor (U18/R5/AE1).
				const r = registry.replay(cursor);
				conn.send(MSG.REPLAY_BEGIN, 0, {});
				for (const f of r.frames) conn.send(f.type, f.sessionId, f.payload);
				conn.send(MSG.REPLAY_END, 0, { truncated: r.truncated });
			} else {
				// Fresh attach: send the current board state.
				conn.send(MSG.SESSION_LIST, 0, { sessions: registry.list() });
			}
		},
		onFrame(frame) {
			if (frame.type === MSG.AUDIO_CHUNK) {
				// U12: voice is bridge-mode only; without an STT backend the frame is
				// dropped (voice off — honest no-op, R7).
				voice?.handleChunk(frame.payload as Parameters<VoiceRoute["handleChunk"]>[0]);
				return;
			}
			if (bridge) {
				bridge.route(frame.type, frame.sessionId, frame.payload);
				return;
			}
			registry.route(frame.type, frame.sessionId, frame.payload);
		},
	});

	return {
		registry,
		port: server.port,
		createSession: (agent, cwd, adapter) => registry.create(agent, cwd, adapter),
		stop: () => {
			bridge?.stop();
			registry.setSink(undefined);
			server.stop();
		},
	};
}
