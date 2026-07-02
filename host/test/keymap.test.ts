import { describe, expect, test } from "bun:test";
import { resolveKeys, padToMacropadLayout } from "../src/tmux/keymap.ts";
import { parsePad } from "../src/layouts/load.ts";
import { toHex } from "@agentbus/protocol";

describe("resolveKeys (U36/KTD7)", () => {
  test("approve -> y CR", () => {
    expect(toHex(resolveKeys("approve")!)).toBe("790d");
  });
  test("interrupt -> Ctrl-C (0x03)", () => {
    expect(toHex(resolveKeys("interrupt")!)).toBe("03");
  });
  test("escape/tab/enter", () => {
    expect(toHex(resolveKeys("escape")!)).toBe("1b");
    expect(toHex(resolveKeys("tab")!)).toBe("09");
    expect(toHex(resolveKeys("enter")!)).toBe("0d");
  });
  test("arrows are CSI sequences", () => {
    expect(toHex(resolveKeys("up")!)).toBe("1b5b41");
    expect(toHex(resolveKeys("down")!)).toBe("1b5b42");
  });
  test("literal: sends the text bytes with escapes", () => {
    expect(toHex(resolveKeys("literal:clear\\r")!)).toBe(toHex(new TextEncoder().encode("clear\r")));
  });
  test("unknown intent is null (fail-safe)", () => {
    expect(resolveKeys("summon_dragon")).toBeNull();
  });
});

describe("padToMacropadLayout", () => {
  test("maps a .pad's intents to keys hex, dropping unknown buttons", () => {
    const pad = parsePad(
      JSON.stringify({
        name: "t",
        buttons: [
          { id: "a", label: "Approve", intent: "approve" },
          { id: "x", label: "Bogus", intent: "does_not_exist" },
          { id: "c", label: "Ctrl-C", intent: "interrupt" },
        ],
      }),
    );
    const layout = padToMacropadLayout(pad);
    expect(layout.buttons.map((b) => b.id)).toEqual(["a", "c"]); // bogus dropped
    expect(layout.buttons[0]!.keys).toBe("790d");
    expect(layout.buttons[1]!.keys).toBe("03");
  });

  test("the shipped terminal.pad resolves every button", async () => {
    const pad = parsePad(await Bun.file("layouts/terminal.pad").text());
    const layout = padToMacropadLayout(pad);
    expect(layout.buttons.length).toBe(pad.buttons.length); // none dropped
    for (const b of layout.buttons) expect(b.keys).toMatch(/^[0-9a-f]+$/);
  });
});
