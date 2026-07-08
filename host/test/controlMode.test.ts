// U31 control-mode parser tests, driven by the S3 capture.

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ControlModeParser, type ControlEvent } from "../src/tmux/controlMode.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/tmux-cc/attach-output-window-session.raw", import.meta.url));

function parseAll(bytes: Uint8Array): ControlEvent[] {
  const p = new ControlModeParser();
  return p.push(bytes);
}

function concatOutput(events: ControlEvent[], paneId: string): Uint8Array {
  const chunks = events.filter((e): e is Extract<ControlEvent, { kind: "output" }> => e.kind === "output" && e.paneId === paneId);
  const total = chunks.reduce((n, c) => n + c.bytes.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c.bytes, off);
    off += c.bytes.length;
  }
  return out;
}

describe("control-mode parser", () => {
  test("%output octal escapes unescape to exact bytes", () => {
    // "\033[1m" -> ESC [ 1 m ; "\007" -> BEL ; "\134" -> backslash ; "\\" -> backslash.
    const line = "%output %0 a\\033[1mb\\007c\\134d\\\\e\r\n";
    const events = parseAll(new TextEncoder().encode(line));
    const out = events.find((e) => e.kind === "output");
    expect(out?.kind).toBe("output");
    const bytes = (out as Extract<ControlEvent, { kind: "output" }>).bytes;
    expect([...bytes]).toEqual([
      0x61, // a
      0x1b, 0x5b, 0x31, 0x6d, // ESC [ 1 m
      0x62, // b
      0x07, // BEL
      0x63, // c
      0x5c, // backslash (from \134)
      0x64, // d
      0x5c, // backslash (from \\)
      0x65, // e
    ]);
  });

  test("%begin/%end pairs a command reply by num", () => {
    const stream = "%begin 100 293 1\r\napi:$0\r\n%end 100 293 1\r\n";
    const events = parseAll(new TextEncoder().encode(stream));
    const begin = events.find((e) => e.kind === "begin");
    const reply = events.find((e) => e.kind === "reply");
    expect(begin).toEqual({ kind: "begin", num: 293 });
    expect(reply).toEqual({ kind: "reply", num: 293, error: false, lines: ["api:$0"] });
  });

  test("%error frames a reply flagged as error", () => {
    const stream = "%begin 100 5 1\r\nno such session\r\n%error 100 5 1\r\n";
    const reply = parseAll(new TextEncoder().encode(stream)).find((e) => e.kind === "reply");
    expect(reply).toEqual({ kind: "reply", num: 5, error: true, lines: ["no such session"] });
  });

  test("partial line across two push() chunks buffers", () => {
    const p = new ControlModeParser();
    const first = p.push(new TextEncoder().encode("%output %0 hel"));
    expect(first).toEqual([]); // no CRLF yet
    const second = p.push(new TextEncoder().encode("lo\r\n"));
    const out = second.find((e) => e.kind === "output");
    expect(out?.kind).toBe("output");
    expect(new TextDecoder().decode((out as Extract<ControlEvent, { kind: "output" }>).bytes)).toBe("hello");
  });

  test("unknown %-line is a benign event, not fatal", () => {
    const events = parseAll(new TextEncoder().encode("%something-new @1 foo\r\n"));
    expect(events).toEqual([{ kind: "unknown", line: "%something-new @1 foo" }]);
  });

  test("notifications parse into typed events", () => {
    const stream =
      "%session-changed $0 api\r\n" +
      "%window-add @1\r\n" +
      "%window-renamed @1 tmux\r\n" +
      "%unlinked-window-close @1\r\n" +
      "%exit\r\n";
    const events = parseAll(new TextEncoder().encode(stream));
    expect(events).toEqual([
      { kind: "session-changed", sessionId: "$0", name: "api" },
      { kind: "window-add", windowId: "@1" },
      { kind: "window-renamed", windowId: "@1", name: "tmux" },
      { kind: "window-close", windowId: "@1" },
      { kind: "exit", reason: "" },
    ]);
  });

  test("full captured fixture parses without throwing and yields output+notifications", () => {
    const raw = readFileSync(FIXTURE);
    const events = parseAll(new Uint8Array(raw));
    // The DCS/ST wrapper is stripped, %begin/%end pairs resolve, %exit terminates.
    expect(events.some((e) => e.kind === "session-changed")).toBe(true);
    expect(events.some((e) => e.kind === "window-add")).toBe(true);
    expect(events.some((e) => e.kind === "exit")).toBe(true);
    // Pane 0 output concatenates to a byte stream containing a BEL (foreground bell).
    const paneBytes = concatOutput(events, "%0");
    expect(paneBytes.length).toBeGreaterThan(0);
    expect(paneBytes.includes(0x07)).toBe(true);
    // The command reply "api:$0" (list-sessions -F) is captured.
    const listReply = events.find((e) => e.kind === "reply" && e.lines.includes("api:$0"));
    expect(listReply).toBeDefined();
  });
});
