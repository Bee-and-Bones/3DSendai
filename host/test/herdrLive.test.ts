// U6 (plan-005) live integration: a REAL herdr daemon (scratch NAMED session,
// never the user's default socket), driven through the real runner and
// bridge. Mirrors tmuxWinsize.test.ts: skipIf when a capable herdr is
// missing, until() polling, teardown via `herdr session stop/delete` in
// afterAll so the scratch session is cleaned up even on test failure.
//
// Needs herdr >= 0.7.2 (session.snapshot + `terminal session control`).
// HERDR_BIN can point at a specific binary (e.g. a pinned test install)
// without touching PATH.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { MSG, fromHex, toHex, type AlertSignalPayload, type TerminalDataPayload } from "@agentbus/protocol";
import { HerdrBridge } from "../src/herdr/bridge.ts";
import { createHerdrRunner } from "../src/herdr/runner.ts";
import { createHerdrClient, herdrDialer } from "../src/herdr/socket.ts";
import { resolveHerdrSocket } from "../src/herdr/runner.ts";
import { createHerdrDiscovery, liveExec } from "../src/herdr/discovery.ts";

const BIN = process.env.HERDR_BIN ?? "herdr";
const SESSION = `3dsendai-live-${process.pid}`;

function herdrVersionOk(): boolean {
  const found = BIN.includes("/") ? Bun.file(BIN).size > 0 : Bun.which(BIN) !== null;
  if (!found) return false;
  const proc = Bun.spawnSync([BIN, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return false;
  const m = new TextDecoder().decode(proc.stdout).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // terminal session control + session.snapshot shipped in 0.7.2
  return maj > 0 || min > 7 || (min === 7 && pat >= 2);
}
const hasHerdr = herdrVersionOk();


async function until(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timeout waiting for herdr state");
    await Bun.sleep(50);
  }
}

/** Frames are cell-painted (cursor-addressed per char): strip escapes before searching. */
function visibleText(hexParts: string[]): string {
  return new TextDecoder()
    .decode(fromHex(hexParts.join("")))
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b./g, "");
}

let server: ReturnType<typeof Bun.spawn> | undefined;
let bridge: HerdrBridge | undefined;
let bridge2: HerdrBridge | undefined;

beforeAll(async () => {
  if (!hasHerdr) return;
  server = Bun.spawn([BIN, "--session", SESSION, "server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const client = createHerdrClient(herdrDialer(resolveHerdrSocket({ session: SESSION })), { timeoutMs: 1000 });
  await until(async () => {
    try {
      const pong = await client.request("ping", {});
      return pong.type === "pong";
    } catch {
      return false;
    }
  }, 15_000);
  // One workspace (its shell pane is the test target).
  await client.request("workspace.create", { label: "live", cwd: "/", focus: true });
}, 20_000);

afterAll(() => {
  bridge?.stop();
  bridge2?.stop();
  if (!hasHerdr) return;
  // Best-effort: stop the scratch daemon and delete its session dir even if
  // the test failed mid-way; then reap the server child.
  Bun.spawnSync([BIN, "session", "stop", SESSION, "--json"], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync([BIN, "session", "delete", SESSION, "--json"], { stdout: "pipe", stderr: "pipe" });
  server?.kill();
});

test.skipIf(!hasHerdr)(
  "live herdr: enumeration, terminal stream, keystroke round-trip",
  async () => {
    const frames: Array<{ type: number; sessionId: number; payload: unknown }> = [];
    const runner = createHerdrRunner({ session: SESSION, herdr: BIN });
    bridge = new HerdrBridge({ runner, sink: (type, sessionId, payload) => frames.push({ type, sessionId, payload }), log: () => {} });
    bridge.start();

    // A pane created in the scratch session appears in enumeration.
    await until(() => frames.some((f) => f.type === MSG.SESSION_LIST));
    const list = frames.filter((f) => f.type === MSG.SESSION_LIST).at(-1)!.payload as { sessions: Array<{ sessionId: number; agent: string }> };
    expect(list.sessions.length).toBe(1);
    expect(list.sessions[0]!.agent).toStartWith("herdr:");
    const sid = list.sessions[0]!.sessionId;

    // Channels are lazy (U4): focusing a row opens its control channel; the
    // repaint (first full frame) then arrives as TERMINAL_DATA.
    bridge.route(MSG.FOCUS_SESSION, sid, { sessionId: sid });
    const hexes = () =>
      frames.filter((f) => f.type === MSG.TERMINAL_DATA && (f.payload as TerminalDataPayload).sessionId === sid).map((f) => (f.payload as TerminalDataPayload).hex);
    await until(() => hexes().length > 0);

    // Pane output arrives as TERMINAL_DATA (marker computed in-shell so the
    // echoed command line itself can't satisfy the assertion).
    const dial = herdrDialer(resolveHerdrSocket({ session: SESSION }));
    const client = createHerdrClient(dial);
    await client.request("pane.send_input", { pane_id: "w1:p1", text: "echo LIVE-$((41+1))", keys: ["enter"] });
    await until(() => visibleText(hexes()).includes("LIVE-42"));

    // A device keystroke round-trips through the control channel.
    bridge.route(MSG.KEYSTROKE, sid, { sessionId: sid, hex: toHex(new TextEncoder().encode("echo K$((2+1))Y\r")) });
    await until(() => visibleText(hexes()).includes("K3Y"));
  },
  30_000,
);

test.skipIf(!hasHerdr)(
  "live herdr: session list --json discovery sees the scratch session running",
  async () => {
    // Force enumeration mode (empty env => no SENDAI_HERDR_* single-target override).
    const discovery = createHerdrDiscovery({ exec: liveExec(), herdr: BIN, env: {} });
    const targets = await discovery.refresh();
    expect(targets.some((t) => t.session === SESSION)).toBe(true);
    discovery.dispose();
  },
  15_000,
);

test.skipIf(!hasHerdr)(
  "live herdr: pane.report_agent blocked -> MACRO_INTENT approve issues an accepted pane.send_keys",
  async () => {
    // Release the previous test's --takeover control channel so this fresh bridge
    // owns the pane cleanly (afterAll still stops it; double-stop is a no-op).
    bridge?.stop();

    const frames: Array<{ type: number; sessionId: number; payload: unknown }> = [];
    const runner = createHerdrRunner({ session: SESSION, herdr: BIN });
    bridge2 = new HerdrBridge({ runner, sink: (type, sessionId, payload) => frames.push({ type, sessionId, payload }), log: () => {} });
    bridge2.start();

    await until(() => frames.some((f) => f.type === MSG.SESSION_LIST));
    const sid = (frames.filter((f) => f.type === MSG.SESSION_LIST).at(-1)!.payload as { sessions: Array<{ sessionId: number }> }).sessions[0]!.sessionId;

    // Drive the scratch pane to `blocked` with a MAPPED kind via a real
    // pane.report_agent, so the bridge's approval gate resolves a key sequence.
    const client = createHerdrClient(herdrDialer(resolveHerdrSocket({ session: SESSION })));
    await client.request("pane.report_agent", {
      pane_id: "w1:p1",
      source: "3dsendai-live",
      agent: "codex",
      state: "blocked",
      message: "awaiting approval",
    });
    // The bridge observes the transition (agent_status_changed -> attention alert).
    await until(() => frames.some((f) => f.type === MSG.ALERT_SIGNAL && (f.payload as AlertSignalPayload).class === "attention" && f.sessionId === sid));

    // MACRO_INTENT approve through the bridge: a fresh snapshot (still blocked)
    // gates to codex->["y"], and the real daemon ACCEPTS the pane.send_keys.
    // Acceptance is proven by the absence of an ERROR (a rejected send_keys, or a
    // failed gate, would surface one); the gate is known-passed via the attention.
    const errsBefore = frames.filter((f) => f.type === MSG.ERROR).length;
    bridge2.route(MSG.MACRO_INTENT, sid, { intent: "approve" });
    // Give the async snapshot+send_keys round-trip time to complete or error.
    await Bun.sleep(600);
    expect(frames.filter((f) => f.type === MSG.ERROR).length).toBe(errsBefore);
  },
  30_000,
);
