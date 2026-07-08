// @agentbus/host public surface.

export { ClaudeCliAdapter, type ClaudeCliOptions } from "./adapters/claude/cli-driver.ts";
export { CodexExecAdapter, type CodexExecOptions } from "./adapters/codex/exec-driver.ts";
export type { Adapter, AdapterEvent, Capability } from "./adapters/interface.ts";
export { CAP_ALLOWLIST, CAP_LIVE_APPROVAL } from "./adapters/interface.ts";
export { createHost, type HostApp, type HostOptions } from "./app.ts";
export { FakeStt, type Stt } from "./audio/stt.ts";
export { type AudioChunkPayload, VoiceRoute, type VoiceRouteOptions } from "./audio/voice.ts";
export {
	sttFromEnv,
	WhisperStt,
	type WhisperSttOptions,
	wavFromPcm16,
} from "./audio/whisper-stt.ts";
export { type BackendKind, resolveBackend } from "./backend.ts";
export { capabilityFor } from "./capability/index.ts";
export {
	HerdrBridge,
	type HerdrBridgeOptions,
	type HerdrChild,
	type HerdrRunner,
	sanitizeLabel,
	stripOsc,
} from "./herdr/bridge.ts";
export { createHerdrRunner, type HerdrRunnerOptions, resolveHerdrSocket } from "./herdr/runner.ts";
export {
	bootstrapHerdr,
	createHerdrClient,
	HERDR_PROTOCOL,
	type HerdrClient,
	type HerdrConn,
	type HerdrDial,
	HerdrError,
	type HerdrEvent,
	herdrDialer,
} from "./herdr/socket.ts";
export { layoutForState } from "./macropad/layout.ts";
export {
	composePairUri,
	type PairInfo,
	type PairModeOptions,
	parsePairUri,
	runPairMode,
} from "./pair.ts";
export { keyFromHex, keyToHex, loadPsk, mintPsk } from "./psk.ts";
export { type QrMatrix, qrCapacity, qrEncode, qrToLuma, qrToTerminal } from "./qr.ts";
export { DurableBuffer } from "./registry/durable.ts";
export { type FrameSink, type RegistryOptions, SessionRegistry } from "./registry/index.ts";
export {
	buildReply,
	type DiscoveryConfig,
	type DiscoveryResponder,
	parseProbe,
	startDiscoveryResponder,
} from "./server/discovery.ts";
export {
	createServer,
	type RunningServer,
	type ServerConfig,
	type ServerHandlers,
} from "./server/index.ts";
export {
	type BridgeSink,
	type ControlChild,
	type SessionBridge,
	splitTerminalHex,
	TmuxBridge,
	type TmuxBridgeOptions,
	type TmuxRunner,
} from "./tmux/bridge.ts";
export { type ControlEvent, ControlModeParser } from "./tmux/control-mode.ts";
export { createTmuxRunner, type TmuxRunnerOptions } from "./tmux/runner.ts";
