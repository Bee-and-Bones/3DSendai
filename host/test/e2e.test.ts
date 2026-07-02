// Host end-to-end over a real loopback socket (U6/U23). Covers the M2
// differentiator (AE2): two concurrent live-approval sessions whose approvals
// route to the correct tile, and reconnect replay (AE1) at the host boundary.

import { expect, test, describe } from "bun:test";
import type { Socket } from "bun";
import { createHost } from "../src/app.ts";
import { FakeAdapter } from "./fake-adapter.ts";
import { MSG, FrameDecoder, encodeFrame, type Frame } from "@agentbus/protocol";

class MockDevice {
  private dec = new FrameDecoder();
  readonly frames: Frame[] = [];
  private watchers: Array<() => void> = [];
  socket!: Socket;

  static async connect(port: number): Promise<MockDevice> {
    const d = new MockDevice();
    d.socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data: (_s, b) => d.onData(b), open() {}, close() {}, error() {} },
    });
    return d;
  }
  private onData(buf: Uint8Array): void {
    for (const f of this.dec.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))) {
      this.frames.push(f);
    }
    for (const w of this.watchers.splice(0)) w();
  }
  send(type: number, sessionId: number, payload: unknown): void {
    this.socket.write(encodeFrame(type, sessionId, payload));
  }
  of(type: number): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }
  async waitFor(pred: () => boolean, ms = 1500): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
      await new Promise<void>((r) => this.watchers.push(r));
    }
  }
  close(): void {
    this.socket.end();
  }
}

describe("host e2e", () => {
  test("AE2: concurrent Claude+Codex approvals route to the correct tile", async () => {
    const host = await createHost({ host: "127.0.0.1", port: 0, token: "t" });
    const claude = new FakeAdapter("claude");
    const codex = new FakeAdapter("codex");
    const idC = host.createSession("claude", "/a", claude);
    const idX = host.createSession("codex", "/b", codex);
    try {
      const dev = await MockDevice.connect(host.port);
      dev.send(MSG.ATTACH, 0, { token: "t" });
      await dev.waitFor(() => dev.of(MSG.SESSION_LIST).length > 0);

      // Both sessions raise a live approval concurrently.
      claude.emit({ kind: "approval", approvalId: "c1", tool: "Edit", detail: "edit a.ts", risk: "low" });
      codex.emit({ kind: "approval", approvalId: "x1", tool: "Bash", detail: "rm -rf build", risk: "high" });
      await dev.waitFor(() => dev.of(MSG.APPROVAL_REQUEST).length >= 2);

      const reqs = dev.of(MSG.APPROVAL_REQUEST);
      const claudeReq = reqs.find((f) => f.sessionId === idC)!;
      const codexReq = reqs.find((f) => f.sessionId === idX)!;
      expect((claudeReq.payload as { tool: string }).tool).toBe("Edit");
      expect((codexReq.payload as { tool: string }).tool).toBe("Bash");

      // Respond per tile: allow Claude, deny Codex.
      dev.send(MSG.APPROVAL_RESPONSE, idC, { approvalId: "c1", decision: "allow" });
      dev.send(MSG.APPROVAL_RESPONSE, idX, { approvalId: "x1", decision: "deny" });
      await Bun.sleep(50);

      // No cross-wiring: each adapter got exactly its own decision.
      expect(claude.approvals).toEqual([{ approvalId: "c1", decision: "allow" }]);
      expect(codex.approvals).toEqual([{ approvalId: "x1", decision: "deny" }]);
      dev.close();
    } finally {
      host.stop();
    }
  });

  test("AE1: reconnect replays output produced while disconnected", async () => {
    const host = await createHost({ host: "127.0.0.1", port: 0, token: "t" });
    const claude = new FakeAdapter("claude");
    const id = host.createSession("claude", "/a", claude);
    try {
      const dev1 = await MockDevice.connect(host.port);
      dev1.send(MSG.ATTACH, 0, { token: "t" });
      await dev1.waitFor(() => dev1.of(MSG.SESSION_LIST).length > 0);
      claude.emit({ kind: "output", text: "before-disconnect" });
      await dev1.waitFor(() => dev1.of(MSG.OUTPUT_CHUNK).length >= 1);
      const cursor = host.registry.replay(0).latest; // device's last-seen cursor
      dev1.close();

      // Output produced while no device is connected.
      claude.emit({ kind: "output", text: "during-disconnect" });

      const dev2 = await MockDevice.connect(host.port);
      dev2.send(MSG.ATTACH, 0, { cursor, token: "t" });
      await dev2.waitFor(() => dev2.of(MSG.REPLAY_END).length > 0);
      const replayed = dev2
        .of(MSG.OUTPUT_CHUNK)
        .map((f) => (f.payload as { text: string }).text);
      expect(replayed).toContain("during-disconnect");
      expect(replayed).not.toContain("before-disconnect"); // already seen (before cursor)
      dev2.close();
    } finally {
      host.stop();
    }
  });
});
