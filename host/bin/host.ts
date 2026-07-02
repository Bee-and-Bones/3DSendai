// 3dsendai host entrypoint. Compiles to a single binary via `bun build --compile`
// (U17/R4), deployable to a laptop, Pi, or VPS.
//
// Env:
//   SENDAI_HOST      bind address (omit => 127.0.0.1 loopback; set 0.0.0.0 for LAN/3DS)
//   SENDAI_PORT      listen port (default 4791)
//   SENDAI_TOKEN     pairing token (a non-loopback bind requires this or SENDAI_PSK)
//   SENDAI_PSK       64-hex-char pre-shared key; when set, the transport is encrypted (U25)
//   SENDAI_DISCOVERY on | off — UDP discovery responder so the 3DS finds this host
//                   without a hardcoded IP (default on when a PSK is set; requires a PSK)
//   SENDAI_DISCOVERY_PORT  UDP discovery port (default 41337)
//   SENDAI_CWD       project directory the agents run in (default: cwd)
//   SENDAI_AGENT     codex | claude | both   (default: codex)
//   SENDAI_SANDBOX   codex sandbox: read-only | workspace-write | danger-full-access (default workspace-write)
//   SENDAI_PERMISSION claude permission mode: default | acceptEdits | auto | bypassPermissions (default acceptEdits)
//   SENDAI_TMUX      1 => terminal mode: bridge the user's tmux instead of spawning agents (U31)
//   SENDAI_TMUX_SESSION  tmux session to attach (omit => whole server / all sessions)
//   SENDAI_TMUX_SOCKET   tmux socket name (-L); omit for the default socket

import { statSync } from "node:fs";
import { createHost, loadPsk, startDiscoveryResponder, CodexExecAdapter, ClaudeCliAdapter, TmuxBridge, createTmuxRunner } from "../src/index.ts";
import { cryptoReady } from "@agentbus/protocol";
import type { Adapter } from "../src/index.ts";

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}
function fatal(msg: string): never {
  console.error(`${new Date().toISOString()} FATAL: ${msg}`);
  process.exit(1);
}

const port = Number(process.env.SENDAI_PORT ?? 4791);
if (!Number.isInteger(port) || port < 0 || port > 65535) fatal(`invalid SENDAI_PORT: ${process.env.SENDAI_PORT}`);

const host = process.env.SENDAI_HOST; // undefined => loopback
const token = process.env.SENDAI_TOKEN;
let psk: Uint8Array | null = null;
try {
  psk = loadPsk(process.env);
} catch (err) {
  fatal((err as Error).message);
}
const cwd = process.env.SENDAI_CWD ?? process.cwd();
const agent = (process.env.SENDAI_AGENT ?? "codex").toLowerCase();
const sandbox = (process.env.SENDAI_SANDBOX ?? "workspace-write") as "read-only" | "workspace-write" | "danger-full-access";
const permissionMode = (process.env.SENDAI_PERMISSION ?? "acceptEdits") as "default" | "acceptEdits" | "auto" | "bypassPermissions";

// --- validation with clear, actionable errors ---
try {
  if (!statSync(cwd).isDirectory()) fatal(`SENDAI_CWD is not a directory: ${cwd}`);
} catch {
  fatal(`SENDAI_CWD does not exist: ${cwd}`);
}
const tmuxMode = (process.env.SENDAI_TMUX ?? "").toLowerCase() === "1" || (process.env.SENDAI_TMUX ?? "").toLowerCase() === "true";
if (!tmuxMode && !["codex", "claude", "both"].includes(agent)) fatal(`SENDAI_AGENT must be codex | claude | both (got: ${agent})`);
if (host && host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && !token && !psk) {
  fatal(`a non-loopback bind (${host}) requires SENDAI_TOKEN or SENDAI_PSK — refusing to run unauthenticated on the network`);
}

// Warn (don't fail) if a selected agent's binary is missing — the device will
// still show a clear per-turn error rather than the host silently hanging.
function checkBinary(name: string): void {
  if (!Bun.which(name)) log(`WARNING: '${name}' not found on PATH — ${name} sessions will report an error until it is installed/authed`);
}

const sessions: Array<{ agent: string; make: () => Adapter }> = [];
if (!tmuxMode) {
  if (agent === "codex" || agent === "both") {
    checkBinary("codex");
    sessions.push({ agent: "codex", make: () => new CodexExecAdapter({ cwd, sandbox }) });
  }
  if (agent === "claude" || agent === "both") {
    checkBinary("claude");
    sessions.push({ agent: "claude", make: () => new ClaudeCliAdapter({ cwd, permissionMode }) });
  }
}

// Terminal mode (U31): the tmux bridge is the session source in place of the
// agent-spawn block above. The bridge attaches lazily on device ATTACH.
let bridge: TmuxBridge | undefined;
if (tmuxMode) {
  checkBinary("tmux");
  checkBinary("python3");
  const runner = createTmuxRunner({
    socket: process.env.SENDAI_TMUX_SOCKET,
    session: process.env.SENDAI_TMUX_SESSION,
  });
  bridge = new TmuxBridge({ runner });
}

let app;
try {
  if (psk) await cryptoReady(); // libsodium WASM init before the listener accepts
  app = await createHost({ host, port, token, psk: psk ?? undefined }, { bridge });
} catch (err) {
  fatal((err as Error).message);
}

for (const s of sessions) {
  const id = app.createSession(s.agent, cwd, s.make());
  log(`session ${id}: ${s.agent} in ${cwd}`);
}

// UDP discovery responder (U27/R21): requires a PSK; on by default when one
// is set. SENDAI_DISCOVERY=off opts out.
const discoveryWanted = (process.env.SENDAI_DISCOVERY ?? "on").toLowerCase() !== "off";
let discovery: { port: number; stop(): void } | null = null;
if (psk && discoveryWanted) {
  const discoveryPort = Number(process.env.SENDAI_DISCOVERY_PORT ?? 41337);
  if (!Number.isInteger(discoveryPort) || discoveryPort < 0 || discoveryPort > 65535) {
    fatal(`invalid SENDAI_DISCOVERY_PORT: ${process.env.SENDAI_DISCOVERY_PORT}`);
  }
  try {
    discovery = await startDiscoveryResponder({ psk, tcpPort: app.port, discoveryPort });
    log(`discovery responder on udp/${discovery.port} (advertising tcp/${app.port})`);
  } catch (err) {
    log(`WARNING: discovery responder failed to start: ${(err as Error).message}`);
  }
} else if (discoveryWanted && !psk) {
  log("discovery disabled: requires SENDAI_PSK (nothing to authenticate replies with)");
}

const sourceDesc = tmuxMode
  ? `tmux bridge (${process.env.SENDAI_TMUX_SESSION ?? "all sessions"})`
  : `${sessions.length} session(s) [${sessions.map((s) => s.agent).join(", ")}]`;
log(
  `3dsendai host on ${host ?? "127.0.0.1"}:${app.port} — ${sourceDesc}, ` +
    `token ${token ? "set" : "none"}, ` +
    `transport ${psk ? "encrypted (PSK)" : "plaintext (loopback dev)"}`,
);

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} — shutting down`);
    discovery?.stop();
    app.stop();
    process.exit(0);
  });
}
