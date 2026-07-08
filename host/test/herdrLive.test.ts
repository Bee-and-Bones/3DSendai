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
import { MSG, fromHex, toHex, type TerminalDataPayload } from "@agentbus/protocol";
import { HerdrBridge } from "../src/herdr/bridge.ts";
import { createHerdrRunner } from "../src/herdr/runner.ts";
import { createHerdrClient, herdrDialer } from "../src/herdr/socket.ts";
import { resolveHerdrSocket } from "../src/herdr/runner.ts";

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

    // Resync opens the control channel; the repaint arrives as TERMINAL_DATA.
    bridge.resync();
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
