import { expect, test, describe } from "bun:test";
import { parsePad, loadPadFile } from "../src/layouts/load.ts";
import { resolveIntent } from "../src/layouts/intent.ts";

describe("pad layout loading", () => {
  test("parsePad returns the layout with its buttons", () => {
    const layout = parsePad(
      JSON.stringify({
        name: "Test deck",
        buttons: [{ id: "t", label: "Run tests", intent: "run_tests" }],
      }),
    );
    expect(layout.name).toBe("Test deck");
    expect(layout.buttons).toEqual([{ id: "t", label: "Run tests", intent: "run_tests" }]);
  });

  test("parsePad throws on invalid JSON", () => {
    expect(() => parsePad("{ not json")).toThrow(/not valid JSON/);
  });

  test("parsePad throws when name is missing", () => {
    expect(() => parsePad(JSON.stringify({ buttons: [] }))).toThrow(/name/);
  });

  test("parsePad throws when buttons is not an array", () => {
    expect(() => parsePad(JSON.stringify({ name: "x", buttons: {} }))).toThrow(/buttons/);
  });

  test("parsePad throws when a button is missing intent", () => {
    expect(() =>
      parsePad(JSON.stringify({ name: "x", buttons: [{ id: "a", label: "A" }] })),
    ).toThrow(/intent/);
  });

  test("loadPadFile loads the example with intent-carrying buttons", async () => {
    const layout = await loadPadFile("layouts/example.pad");
    expect(layout.buttons.length).toBeGreaterThan(0);
    for (const button of layout.buttons) {
      expect(button.intent).toBeTruthy();
    }
  });
});

describe("intent resolution across agents", () => {
  test("one intent resolves for both agents", () => {
    expect(resolveIntent("run_tests", "claude")).toBeTruthy();
    expect(resolveIntent("run_tests", "codex")).toBeTruthy();
  });

  test("unknown intent throws", () => {
    expect(() => resolveIntent("nope", "claude")).toThrow(/Unknown intent/);
  });

  test("a loaded example button's intent resolves for at least one agent", async () => {
    const layout = await loadPadFile("layouts/example.pad");
    const first = layout.buttons[0];
    expect(first).toBeDefined();
    expect(resolveIntent(first!.intent, "claude")).toBeTruthy();
  });
});
