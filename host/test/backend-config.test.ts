// U5 (plan-005) backend selection + herdr socket resolution. host/bin/host.ts
// maps resolveBackend's answer 1:1 onto which bridge it constructs (tmux ->
// TmuxBridge, herdr -> HerdrBridge), so these cover the launch-config rules;
// the herdr wiring itself is exercised end-to-end in e2e-herdr.test.ts.

import { expect, test, describe } from "bun:test";
import { resolveBackend } from "../src/backend.ts";
import { resolveHerdrSocket } from "../src/herdr/runner.ts";

describe("resolveBackend", () => {
  test("SENDAI_BACKEND=herdr selects the herdr backend", () => {
    expect(resolveBackend({ SENDAI_BACKEND: "herdr" })).toBe("herdr");
    expect(resolveBackend({ SENDAI_BACKEND: "HERDR" })).toBe("herdr");
  });

  test("unset defaults to existing behavior (agents; SENDAI_TMUX=1 still selects tmux)", () => {
    expect(resolveBackend({})).toBe("agents");
    expect(resolveBackend({ SENDAI_TMUX: "1" })).toBe("tmux");
    expect(resolveBackend({ SENDAI_TMUX: "true" })).toBe("tmux");
    expect(resolveBackend({ SENDAI_TMUX: "0" })).toBe("agents");
  });

  test("SENDAI_BACKEND=tmux + SENDAI_TMUX=1 agree; herdr + SENDAI_TMUX=1 is fatal", () => {
    expect(resolveBackend({ SENDAI_BACKEND: "tmux", SENDAI_TMUX: "1" })).toBe("tmux");
    expect(() => resolveBackend({ SENDAI_BACKEND: "herdr", SENDAI_TMUX: "1" })).toThrow(/conflicts with SENDAI_TMUX/);
  });

  test("invalid backend value is fatal with a clear message", () => {
    expect(() => resolveBackend({ SENDAI_BACKEND: "screen" })).toThrow(/must be tmux \| herdr.*screen/);
  });
});

describe("resolveHerdrSocket", () => {
  const home = "/home/user";

  test("explicit path wins over named session over default", () => {
    expect(resolveHerdrSocket({ socket: "/tmp/x.sock", session: "dev" }, home)).toBe("/tmp/x.sock");
    expect(resolveHerdrSocket({ session: "dev" }, home)).toBe("/home/user/.config/herdr/sessions/dev/herdr.sock");
    expect(resolveHerdrSocket({}, home)).toBe("/home/user/.config/herdr/herdr.sock");
  });
});
