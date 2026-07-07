// @agentbus/host public surface.
export { createHost, type HostApp, type HostOptions } from "./app.ts";
export { TmuxBridge, splitTerminalHex, type TmuxRunner, type ControlChild, type BridgeSink, type TmuxBridgeOptions } from "./tmux/bridge.ts";
export { createTmuxRunner, type TmuxRunnerOptions } from "./tmux/runner.ts";
export { ControlModeParser, type ControlEvent } from "./tmux/control-mode.ts";
export { createServer, type ServerConfig, type ServerHandlers, type RunningServer } from "./server/index.ts";
export { loadPsk, keyFromHex, keyToHex, mintPsk } from "./psk.ts";
export { composePairUri, parsePairUri, runPairMode, type PairInfo, type PairModeOptions } from "./pair.ts";
export { qrEncode, qrToTerminal, qrToLuma, qrCapacity, type QrMatrix } from "./qr.ts";
export {
  startDiscoveryResponder,
  parseProbe,
  buildReply,
  type DiscoveryResponder,
  type DiscoveryConfig,
} from "./server/discovery.ts";
export { SessionRegistry, type FrameSink, type RegistryOptions } from "./registry/index.ts";
export { DurableBuffer } from "./registry/durable.ts";
export { capabilityFor } from "./capability/index.ts";
export { layoutForState } from "./macropad/layout.ts";
export type { Adapter, AdapterEvent, Capability } from "./adapters/interface.ts";
export { CAP_LIVE_APPROVAL, CAP_ALLOWLIST } from "./adapters/interface.ts";
export { CodexExecAdapter, type CodexExecOptions } from "./adapters/codex/exec-driver.ts";
export { ClaudeCliAdapter, type ClaudeCliOptions } from "./adapters/claude/cli-driver.ts";
