// U5 (plan-005) backend selection + herdr socket resolution. host/bin/host.ts
// maps resolveBackend's answer 1:1 onto which bridge it constructs (tmux ->
// TmuxBridge, herdr -> HerdrBridge), so these cover the launch-config rules;
// the herdr wiring itself is exercised end-to-end in e2eHerdr.test.ts.

import { expect, test, describe } from "bun:test";
import { resolveBackend } from "../src/backend.ts";
import { resolveHerdrSocket } from "../src/herdr/runner.ts";

describe("resolveBackend", () => {
  test("unset defaults to herdr (U8/plan-001: agent supervision is the flagship path)", () => {
    expect(resolveBackend({})).toBe("herdr");
  });

  test("SENDAI_BACKEND=agents selects the structured agent stack explicitly", () => {
    expect(resolveBackend({ SENDAI_BACKEND: "agents" })).toBe("agents");
    expect(resolveBackend({ SENDAI_BACKEND: "AGENTS" })).toBe("agents");
  });

  test("SENDAI_BACKEND=herdr selects the herdr backend", () => {
    expect(resolveBackend({ SENDAI_BACKEND: "herdr" })).toBe("herdr");
    expect(resolveBackend({ SENDAI_BACKEND: "HERDR" })).toBe("herdr");
  });

  test("SENDAI_TMUX=1 alone (SENDAI_BACKEND unset) selects tmux, overriding the herdr default", () => {
    expect(resolveBackend({ SENDAI_TMUX: "1" })).toBe("tmux");
    expect(resolveBackend({ SENDAI_TMUX: "true" })).toBe("tmux");
    expect(resolveBackend({ SENDAI_TMUX: "0" })).toBe("herdr");
  });

  test("SENDAI_BACKEND=tmux + SENDAI_TMUX=1 agree; herdr + SENDAI_TMUX=1 is fatal", () => {
    expect(resolveBackend({ SENDAI_BACKEND: "tmux", SENDAI_TMUX: "1" })).toBe("tmux");
    expect(() => resolveBackend({ SENDAI_BACKEND: "herdr", SENDAI_TMUX: "1" })).toThrow(/conflicts with SENDAI_TMUX/);
  });

  test("invalid backend value is fatal, naming the valid set", () => {
    expect(() => resolveBackend({ SENDAI_BACKEND: "screen" })).toThrow(/must be agents \| tmux \| herdr.*screen/);
  });
});

describe("resolveHerdrSocket", () => {
  const home = "/home/user";

  test("explicit path wins over named session over default", () => {
    expect(resolveHerdrSocket({ socket: "/tmp/x.sock", session: "dev" }, home)).toBe("/tmp/x.sock");
    expect(resolveHerdrSocket({ session: "dev" }, home)).toBe("/home/user/.config/herdr/sessions/dev/herdr.sock");
    expect(resolveHerdrSocket({}, home)).toBe("/home/user/.config/herdr/herdr.sock");
  });

  test('the literal session "default" resolves to the top-level socket, not sessions/default (F6)', () => {
    // The default session's socket is ~/.config/herdr/herdr.sock (fixtures README
    // default-session addressing) — sessions/default/herdr.sock does not exist.
    expect(resolveHerdrSocket({ session: "default" }, home)).toBe(
      "/home/user/.config/herdr/herdr.sock",
    );
    // A named session is unchanged.
    expect(resolveHerdrSocket({ session: "work" }, home)).toBe(
      "/home/user/.config/herdr/sessions/work/herdr.sock",
    );
  });
});
