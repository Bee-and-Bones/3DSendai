// ag3nt host entrypoint. Compiles to a single binary via `bun build --compile`
// (U17/R4), deployable to a laptop, Pi, or VPS.
//
// Env:
//   AG3NT_HOST      bind address (omit => 127.0.0.1 loopback; set 0.0.0.0 for LAN/3DS)
//   AG3NT_PORT      listen port (default 4791)
//   AG3NT_TOKEN     pairing token (REQUIRED for a non-loopback bind)
//   AG3NT_CWD       project directory the agents run in (default: cwd)
//   AG3NT_AGENT     codex | claude | both   (default: codex)
//   AG3NT_SANDBOX   codex sandbox: read-only | workspace-write | danger-full-access (default workspace-write)
//   AG3NT_PERMISSION claude permission mode: default | acceptEdits | auto | bypassPermissions (default acceptEdits)

import { statSync } from "node:fs";
import { createHost, CodexExecAdapter, ClaudeCliAdapter } from "../src/index.ts";
import type { Adapter } from "../src/index.ts";

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}
function fatal(msg: string): never {
  console.error(`${new Date().toISOString()} FATAL: ${msg}`);
  process.exit(1);
}

const port = Number(process.env.AG3NT_PORT ?? 4791);
if (!Number.isInteger(port) || port < 0 || port > 65535) fatal(`invalid AG3NT_PORT: ${process.env.AG3NT_PORT}`);

const host = process.env.AG3NT_HOST; // undefined => loopback
const token = process.env.AG3NT_TOKEN;
const cwd = process.env.AG3NT_CWD ?? process.cwd();
const agent = (process.env.AG3NT_AGENT ?? "codex").toLowerCase();
const sandbox = (process.env.AG3NT_SANDBOX ?? "workspace-write") as "read-only" | "workspace-write" | "danger-full-access";
const permissionMode = (process.env.AG3NT_PERMISSION ?? "acceptEdits") as "default" | "acceptEdits" | "auto" | "bypassPermissions";

// --- validation with clear, actionable errors ---
try {
  if (!statSync(cwd).isDirectory()) fatal(`AG3NT_CWD is not a directory: ${cwd}`);
} catch {
  fatal(`AG3NT_CWD does not exist: ${cwd}`);
}
if (!["codex", "claude", "both"].includes(agent)) fatal(`AG3NT_AGENT must be codex | claude | both (got: ${agent})`);
if (host && host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && !token) {
  fatal(`a non-loopback bind (${host}) requires AG3NT_TOKEN — refusing to run unauthenticated on the network`);
}

// Warn (don't fail) if a selected agent's binary is missing — the device will
// still show a clear per-turn error rather than the host silently hanging.
function checkBinary(name: string): void {
  if (!Bun.which(name)) log(`WARNING: '${name}' not found on PATH — ${name} sessions will report an error until it is installed/authed`);
}

const sessions: Array<{ agent: string; make: () => Adapter }> = [];
if (agent === "codex" || agent === "both") {
  checkBinary("codex");
  sessions.push({ agent: "codex", make: () => new CodexExecAdapter({ cwd, sandbox }) });
}
if (agent === "claude" || agent === "both") {
  checkBinary("claude");
  sessions.push({ agent: "claude", make: () => new ClaudeCliAdapter({ cwd, permissionMode }) });
}

let app;
try {
  app = createHost({ host, port, token });
} catch (err) {
  fatal((err as Error).message);
}

for (const s of sessions) {
  const id = app.createSession(s.agent, cwd, s.make());
  log(`session ${id}: ${s.agent} in ${cwd}`);
}

log(
  `ag3nt host on ${host ?? "127.0.0.1"}:${app.port} — ${sessions.length} session(s) ` +
    `[${sessions.map((s) => s.agent).join(", ")}], token ${token ? "set" : "none (loopback only)"}`,
);

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} — shutting down`);
    app.stop();
    process.exit(0);
  });
}
