import { expect, test, describe } from "bun:test";
import { capabilityFor } from "../src/capability/index.ts";

describe("capability negotiation", () => {
  test("claude supports live approval", () => {
    expect(capabilityFor("claude").liveApproval).toBe(true);
  });
  test("codex via app-server supports live approval", () => {
    expect(capabilityFor("codex", "app-server").liveApproval).toBe(true);
    expect(capabilityFor("codex").liveApproval).toBe(true); // default is app-server
  });
  test("codex exec fallback is allowlist-only", () => {
    expect(capabilityFor("codex", "exec").liveApproval).toBe(false);
  });
  test("unknown/future agents default to allowlist", () => {
    expect(capabilityFor("something-new").liveApproval).toBe(false);
  });
});
