// U3 (plan-005) herdr socket client tests. Hermetic: a fake daemon replays
// RECV lines captured from a real herdr 0.7.2 (host/test/fixtures/herdr/), so
// the parser is proven against real wire bytes, no live herdr needed.
//
// Note on correlation scenarios: herdr 0.7.2 answers one request per
// connection (fixtures README), so "out-of-order responses" means concurrent
// requests on separate connections resolving in reverse order — not
// interleaved ids on one pipe.

import { expect, test, describe } from "bun:test";
import {
  createHerdrClient,
  bootstrapHerdr,
  parseSnapshot,
  HerdrError,
  HERDR_PROTOCOL,
  type HerdrConn,
  type HerdrDial,
  type HerdrEvent,
} from "../src/herdr/socket.ts";

// --- fixture access -----------------------------------------------------------

const FIXTURES = new URL("./fixtures/herdr/", import.meta.url);

interface FixtureLine {
  dir: "SEND" | "RECV";
  raw: string;
  msg: Record<string, unknown>;
}

async function loadFixture(name: string): Promise<FixtureLine[]> {
  const text = await Bun.file(new URL(name, FIXTURES)).text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const space = l.indexOf(" ");
      const dir = l.slice(0, space).replace(/\(.*\)/, "") as "SEND" | "RECV";
      const raw = l.slice(space + 1);
      return { dir, raw, msg: JSON.parse(raw) as Record<string, unknown> };
    });
}

/** RECV line answering the fixture request with the given method. */
async function fixtureResponse(file: string, method: string): Promise<string> {
  const lines = await loadFixture(file);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.dir === "SEND" && l.msg.method === method) {
      const sentId = l.msg.id;
      const resp = lines.slice(i + 1).find((r) => r.dir === "RECV" && r.msg.id === sentId);
      if (resp) return resp.raw;
    }
  }
  throw new Error(`no fixture response for ${method} in ${file}`);
}

/** Re-id a captured response line so it correlates with a live request id. */
function reId(raw: string, id: string): string {
  const msg = JSON.parse(raw) as Record<string, unknown>;
  msg.id = id;
  return JSON.stringify(msg);
}

// --- fake daemon ----------------------------------------------------------------

class FakeConn implements HerdrConn {
  dataListener: ((b: Uint8Array) => void) | undefined;
  closeListener: (() => void) | undefined;
  written: string[] = [];
  ended = false;
  constructor(private readonly onWrite: (conn: FakeConn, line: string) => void) {}
  write(line: string) {
    this.written.push(line);
    this.onWrite(this, line.trim());
  }
  onData(l: (b: Uint8Array) => void) {
    this.dataListener = l;
  }
  onClose(l: () => void) {
    this.closeListener = l;
  }
  end() {
    this.ended = true;
  }
  feed(text: string) {
    this.dataListener?.(new TextEncoder().encode(text));
  }
  /** Daemon-side close (one-request-per-connection behavior). */
  close() {
    this.closeListener?.();
  }
}

/**
 * Fake daemon honoring the observed connection model: `respond` maps a
 * request line to raw RECV line(s); after responding to a non-subscribe
 * request the connection closes, like the real daemon.
 */
function fakeDaemon(respond: (msg: Record<string, unknown>, conn: FakeConn) => string[] | Promise<string[]>) {
  const conns: FakeConn[] = [];
  const dial: HerdrDial = async () => {
    const conn = new FakeConn(async (c, line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const out = await respond(msg, c);
      for (const l of out) c.feed(l + "\n");
      // Mirror the real daemon: close after answering a plain request. An
      // empty answer means the test is holding the response open.
      if (out.length > 0 && msg.method !== "events.subscribe") c.close();
    });
    conns.push(conn);
    return conn;
  };
  return { dial, conns };
}

/** Standard responder built from fixture captures. */
async function fixtureResponder() {
  const ping = await fixtureResponse("socket-bootstrap-empty.ndjson", "ping");
  const snapshot = await fixtureResponse("socket-snapshot-populated.ndjson", "session.snapshot");
  const subLines = await loadFixture("socket-subscribe-events.ndjson");
  const subAck = subLines.find((l) => l.dir === "RECV" && l.msg.id !== undefined)!.raw;
  const subEvents = subLines.filter((l) => l.dir === "RECV" && l.msg.id === undefined).map((l) => l.raw);
  return (msg: Record<string, unknown>): string[] => {
    const id = msg.id as string;
    switch (msg.method) {
      case "ping":
        return [reId(ping, id)];
      case "session.snapshot":
        return [reId(snapshot, id)];
      case "events.subscribe":
        return [reId(subAck, id), ...subEvents];
      default:
        return [JSON.stringify({ id, error: { code: "invalid_request", message: `unknown method ${msg.method}` } })];
    }
  };
}

// --- tests ----------------------------------------------------------------------

describe("herdr socket client", () => {
  test("concurrent requests on separate connections resolve out of order", async () => {
    const resolvers: Array<() => void> = [];
    const daemon = fakeDaemon(async (msg) => {
      // Hold every response until released, then answer in reverse order.
      await new Promise<void>((res) => resolvers.push(res));
      return [JSON.stringify({ id: msg.id, result: { type: "ok", method: msg.method } })];
    });
    const client = createHerdrClient(daemon.dial);
    const a = client.request("pane.focus", { pane_id: "w1:p1" });
    const b = client.request("pane.zoom", { pane_id: "w1:p2" });
    await Bun.sleep(0); // let both dials complete and queue
    expect(resolvers.length).toBe(2);
    resolvers[1]!(); // answer b first
    expect(((await b) as { method: string }).method).toBe("pane.zoom");
    resolvers[0]!();
    expect(((await a) as { method: string }).method).toBe("pane.focus");
  });

  test("a pushed event arriving mid-request resolves both correctly", async () => {
    let pendingConn: FakeConn | undefined;
    const daemon = fakeDaemon((msg, conn) => {
      if (msg.method === "pane.list") {
        pendingConn = conn; // hold the response; we'll feed it manually
        return [];
      }
      return [JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })];
    });
    const client = createHerdrClient(daemon.dial);
    const events: HerdrEvent[] = [];
    await client.subscribe([{ type: "pane.exited" }], { onEvent: (e) => events.push(e), onClose: () => {} });
    const listReq = client.request("pane.list", {});
    await Bun.sleep(0);
    // Event pushes while pane.list is still pending (fixture-shaped line).
    const sub = daemon.conns.find((c) => c.written[0]?.includes("events.subscribe"))!;
    sub.feed(`{"data":{"pane_id":"w1:p3","type":"pane_exited","workspace_id":"w1"},"event":"pane_exited"}\n`);
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe("pane_exited");
    expect(events[0]!.data.pane_id).toBe("w1:p3");
    pendingConn!.feed(JSON.stringify({ id: JSON.parse(pendingConn!.written[0]!).id, result: { type: "pane_list", panes: [] } }) + "\n");
    const result = await listReq;
    expect(result.type).toBe("pane_list");
  });

  test("a JSON line split across two socket chunks parses once complete", async () => {
    const daemon = fakeDaemon(() => []);
    const client = createHerdrClient(daemon.dial);
    const p = client.request("ping", {});
    await Bun.sleep(0);
    const conn = daemon.conns[0]!;
    const id = (JSON.parse(conn.written[0]!) as { id: string }).id;
    const line = JSON.stringify({ id, result: { type: "pong", version: "0.7.2", protocol: 16 } }) + "\n";
    conn.feed(line.slice(0, 25));
    conn.feed(line.slice(25));
    const result = await p;
    expect(result.type).toBe("pong");
  });

  test("error response rejects the request with code and message (fixture bytes)", async () => {
    const raw = await fixtureResponse("socket-bootstrap-empty.ndjson", "pane.read");
    const daemon = fakeDaemon((msg) => [reId(raw, msg.id as string)]);
    const client = createHerdrClient(daemon.dial);
    const err = (await client.request("pane.read", { pane_id: "w9:p9", source: "visible" }).catch((e) => e)) as HerdrError;
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("pane_not_found");
    expect(err.message).toContain("w9:p9");
  });

  test("unknown fields in results are ignored (fixture snapshot has layouts/agents/scroll)", async () => {
    const raw = await fixtureResponse("socket-snapshot-populated.ndjson", "session.snapshot");
    const snap = parseSnapshot(JSON.parse(raw).result);
    expect(snap.panes.length).toBe(2);
    expect(snap.panes[0]!.pane_id).toBe("w1:p1");
    expect(snap.focused_pane_id).toBe("w1:p1");
    expect(snap.tabs[0]!.tab_id).toBe("w1:t1");
  });

  test("older daemon protocol is a fatal HerdrError", async () => {
    const respond = await fixtureResponder();
    const daemon = fakeDaemon((msg) => {
      if (msg.method === "ping") {
        return [JSON.stringify({ id: msg.id, result: { type: "pong", version: "0.6.0", protocol: 14 } })];
      }
      return respond(msg);
    });
    const err = (await bootstrapHerdr(createHerdrClient(daemon.dial)).catch((e) => e)) as HerdrError;
    expect(err.code).toBe("protocol_too_old");
    expect(err.message).toContain("14");
  });

  test("newer protocol with a capability-complete snapshot warns and continues", async () => {
    const respond = await fixtureResponder();
    const daemon = fakeDaemon((msg) => {
      if (msg.method === "ping") {
        return [JSON.stringify({ id: msg.id, result: { type: "pong", version: "0.9.0", protocol: HERDR_PROTOCOL + 1 } })];
      }
      return respond(msg);
    });
    const boot = await bootstrapHerdr(createHerdrClient(daemon.dial));
    expect(boot.warnings.length).toBe(1);
    expect(boot.warnings[0]).toContain("newer");
    expect(boot.snapshot.panes.length).toBe(2);
  });

  test("newer-protocol snapshot missing agent_status escalates to the error path", async () => {
    const rawSnap = JSON.parse(await fixtureResponse("socket-snapshot-populated.ndjson", "session.snapshot"));
    for (const p of rawSnap.result.snapshot.panes) delete p.agent_status; // simulated rename in a future daemon
    const daemon = fakeDaemon((msg) => {
      if (msg.method === "ping") {
        return [JSON.stringify({ id: msg.id, result: { type: "pong", version: "0.9.0", protocol: HERDR_PROTOCOL + 1 } })];
      }
      rawSnap.id = msg.id;
      return [JSON.stringify(rawSnap)];
    });
    const err = (await bootstrapHerdr(createHerdrClient(daemon.dial)).catch((e) => e)) as HerdrError;
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("bad_snapshot");
  });

  test("socket close with a pending request rejects it", async () => {
    const daemon = fakeDaemon(() => []);
    const client = createHerdrClient(daemon.dial);
    const p = client.request("session.snapshot", {});
    await Bun.sleep(0);
    daemon.conns[0]!.close();
    const err = (await p.catch((e) => e)) as HerdrError;
    expect(err.code).toBe("closed");
  });

  test("no response within the timeout rejects instead of hanging (R9)", async () => {
    const daemon = fakeDaemon(() => []);
    const client = createHerdrClient(daemon.dial, { timeoutMs: 20 });
    const err = (await client.request("ping", {}).catch((e) => e)) as HerdrError;
    expect(err.code).toBe("timeout");
  });

  test("subscribe delivers the fixture ack, replayed state, and live pushes", async () => {
    const respond = await fixtureResponder();
    const daemon = fakeDaemon((msg) => respond(msg));
    const client = createHerdrClient(daemon.dial);
    const events: HerdrEvent[] = [];
    await client.subscribe(
      [{ type: "pane.exited" }, { type: "pane.agent_status_changed", pane_id: "w1:p2" }],
      { onEvent: (e) => events.push(e), onClose: () => {} },
    );
    // The fixture capture replays existing panes then streams live transitions.
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("pane_created");
    expect(kinds).toContain("pane.agent_status_changed");
    expect(kinds).toContain("pane_exited");
    const statuses = events.filter((e) => e.event === "pane.agent_status_changed").map((e) => e.data.agent_status);
    expect(statuses).toEqual(["blocked", "working", "idle"]);
  });

  test("subscribe-connection drop after ack fires onClose once", async () => {
    const respond = await fixtureResponder();
    const daemon = fakeDaemon((msg) => (msg.method === "events.subscribe" ? [JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })] : respond(msg)));
    const client = createHerdrClient(daemon.dial);
    let closes = 0;
    await client.subscribe([{ type: "pane.exited" }], { onEvent: () => {}, onClose: () => closes++ });
    const sub = daemon.conns[0]!;
    sub.close();
    sub.close(); // double close must not double-fire
    expect(closes).toBe(1);
  });

  test("caller-initiated end() does not fire onClose", async () => {
    const daemon = fakeDaemon((msg) => [JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })]);
    const client = createHerdrClient(daemon.dial);
    let closes = 0;
    const sub = await client.subscribe([{ type: "pane.exited" }], { onEvent: () => {}, onClose: () => closes++ });
    sub.end();
    daemon.conns[0]!.close(); // the transport close that follows our end()
    expect(closes).toBe(0);
  });

  test("connection dropped before subscribe ack rejects", async () => {
    const daemon = fakeDaemon((_msg, conn) => {
      conn.close();
      return [];
    });
    const client = createHerdrClient(daemon.dial);
    const err = (await client
      .subscribe([{ type: "pane.exited" }], { onEvent: () => {}, onClose: () => {} })
      .catch((e) => e)) as HerdrError;
    expect(err.code).toBe("closed");
  });

  test("dial failure (daemon absent) propagates as an error, not a hang", async () => {
    const dial: HerdrDial = async () => {
      throw new Error("connect ENOENT /tmp/nope/herdr.sock");
    };
    const client = createHerdrClient(dial);
    const err = (await client.request("ping", {}).catch((e) => e)) as Error;
    expect(err.message).toContain("ENOENT");
  });

  test("bootstrap against fixture bytes yields ping info and parsed snapshot", async () => {
    const respond = await fixtureResponder();
    const daemon = fakeDaemon((msg) => respond(msg));
    const boot = await bootstrapHerdr(createHerdrClient(daemon.dial));
    expect(boot.ping.protocol).toBe(16);
    expect(boot.ping.version).toBe("0.7.2");
    expect(boot.warnings).toEqual([]);
    expect(boot.snapshot.panes.map((p) => p.pane_id)).toEqual(["w1:p1", "w1:p2"]);
  });
});
