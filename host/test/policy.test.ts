import { expect, test, describe } from "bun:test";
import {
  classifyAction,
  decide,
  defaultPolicy,
  type Policy,
} from "../src/policy/index.ts";

const REPO = "/repo";
const LIVE = { liveApproval: true };
const ALLOWLIST = { liveApproval: false };

// A per-repo policy that auto-approves reads and edits.
const repoPolicy: Policy = {
  autoApprove: ["read", "edit"],
  alwaysAsk: ["shell", "network", "delete"],
};

describe("classifyAction", () => {
  test("reads are low risk", () => {
    expect(classifyAction("Read", "/repo/src/index.ts", REPO)).toEqual({
      class: "read",
      risk: "low",
    });
  });
  test("shell is high risk", () => {
    expect(classifyAction("Bash", "echo hi").class).toBe("shell");
    expect(classifyAction("Bash", "echo hi").risk).toBe("high");
  });
  test("network is high risk", () => {
    expect(classifyAction("fetch", "https://x").class).toBe("network");
  });
  test("shell command with a network tool classifies as network", () => {
    expect(classifyAction("Bash", "curl https://evil.example").class).toBe("network");
  });
  test("delete is high risk even inside a shell", () => {
    expect(classifyAction("Bash", "rm -rf /repo/build").class).toBe("delete");
    expect(classifyAction("rm", "notes.txt").class).toBe("delete");
  });
  test("edit inside the repo is low risk", () => {
    expect(classifyAction("Edit", "/repo/src/a.ts", REPO).risk).toBe("low");
  });
  test("edit outside the repo root is high risk", () => {
    expect(classifyAction("Edit", "/etc/passwd", REPO).risk).toBe("high");
  });
  test("unrecognized tool is unknown/high", () => {
    expect(classifyAction("Franzibulator", "do a thing")).toEqual({
      class: "unknown",
      risk: "high",
    });
  });
});

describe("decide", () => {
  test("read under repo root auto-approves for a live agent", () => {
    const action = classifyAction("Read", "/repo/src/index.ts", REPO);
    expect(decide(repoPolicy, action, LIVE)).toBe("auto_approve");
  });

  test("rm escalates for a live agent, blocks for an allowlist agent", () => {
    const action = classifyAction("Bash", "rm -rf /repo/build", REPO);
    expect(decide(repoPolicy, action, LIVE)).toBe("escalate");
    expect(decide(repoPolicy, action, ALLOWLIST)).toBe("blocked");
  });

  test("shell with a network command escalates for a live agent", () => {
    const action = classifyAction("Bash", "curl https://evil.example", REPO);
    expect(decide(repoPolicy, action, LIVE)).toBe("escalate");
  });

  test("edit outside repo root escalates even when edits are allowed", () => {
    const action = classifyAction("Edit", "/etc/passwd", REPO);
    // edit is in autoApprove, but the out-of-repo path makes it high risk.
    expect(decide(repoPolicy, action, LIVE)).toBe("escalate");
    expect(decide(repoPolicy, action, ALLOWLIST)).toBe("blocked");
  });

  test("unknown tool fails safe: escalate live, block allowlist (NEVER auto)", () => {
    const action = classifyAction("Franzibulator", "do a thing", REPO);
    expect(decide(repoPolicy, action, LIVE)).toBe("escalate");
    expect(decide(repoPolicy, action, ALLOWLIST)).toBe("blocked");
    expect(decide(repoPolicy, action, LIVE)).not.toBe("auto_approve");
  });

  test("default policy is per-repo fallback: only reads auto-approve", () => {
    const policy = defaultPolicy();
    const read = classifyAction("Read", "/repo/x.ts", REPO);
    const edit = classifyAction("Edit", "/repo/x.ts", REPO);
    expect(decide(policy, read, LIVE)).toBe("auto_approve");
    // An edit is not auto-approved under the conservative default.
    expect(decide(policy, edit, LIVE)).toBe("escalate");
    expect(decide(policy, edit, ALLOWLIST)).toBe("blocked");
  });
});
