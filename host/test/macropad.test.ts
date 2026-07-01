import { expect, test, describe } from "bun:test";
import { layoutForState } from "../src/macropad/layout.ts";
import { CAP_ALLOWLIST, CAP_LIVE_APPROVAL } from "../src/adapters/interface.ts";

const ids = (state: Parameters<typeof layoutForState>[0], ctx?: Parameters<typeof layoutForState>[1]) =>
  layoutForState(state, ctx).buttons.map((b) => b.id);

describe("macropad layout emitter", () => {
  test("idle deck offers dictate/keyboard/switch plus snippets", () => {
    const ids0 = ids("idle", { snippets: ["run tests"] });
    expect(ids0).toContain("dictate");
    expect(ids0).toContain("keyboard");
    expect(ids0).toContain("switch");
    expect(ids0).toContain("snippet-0");
  });

  test("dictating deck offers stop/cancel", () => {
    expect(ids("dictating")).toEqual(["stop", "cancel"]);
  });

  test("pending-approval deck offers allow/deny when live approval is supported", () => {
    const b = ids("pending_approval", { capability: CAP_LIVE_APPROVAL });
    expect(b).toContain("allow");
    expect(b).toContain("deny");
  });

  test("pending-approval collapses to blocked for allowlist agents", () => {
    expect(ids("pending_approval", { capability: CAP_ALLOWLIST })).toEqual(["dismiss"]);
  });

  test("menu deck renders disambiguation candidates when present", () => {
    const b = layoutForState("menu", { candidates: [{ id: "f1", label: "auth.ts" }] });
    expect(b.buttons).toEqual([{ id: "f1", label: "auth.ts" }]);
  });

  test("each state stamps its own name", () => {
    for (const s of ["idle", "dictating", "pending_approval", "menu"] as const) {
      expect(layoutForState(s).state).toBe(s);
    }
  });
});
