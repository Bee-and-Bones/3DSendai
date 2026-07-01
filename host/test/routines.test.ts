import { expect, test, describe } from "bun:test";
import { RoutineRecorder } from "../src/routines/record.ts";
import type { Routine, RoutineSink } from "../src/routines/replay.ts";
import {
  replayRoutine,
  serializeRoutine,
  deserializeRoutine,
} from "../src/routines/replay.ts";

function makeSink() {
  const events: string[] = [];
  const sink: RoutineSink = {
    prompt: (text) => events.push(`prompt:${text}`),
    approval: (decision) => events.push(`approval:${decision}`),
  };
  return { sink, events };
}

describe("routine recorder", () => {
  test("records an ordered prompt/approval/prompt sequence", () => {
    const rec = new RoutineRecorder();
    rec.start("scaffold-and-test");
    rec.recordPrompt("scaffold endpoint");
    rec.recordApproval("allow");
    rec.recordPrompt("run tests");
    const routine = rec.stop();

    expect(routine.name).toBe("scaffold-and-test");
    expect(routine.steps).toEqual([
      { kind: "prompt", text: "scaffold endpoint" },
      { kind: "approval", decision: "allow" },
      { kind: "prompt", text: "run tests" },
    ]);
  });

  test("stop() before start() throws", () => {
    const rec = new RoutineRecorder();
    expect(() => rec.stop()).toThrow();
  });

  test("recording after stop() throws", () => {
    const rec = new RoutineRecorder();
    rec.start("r");
    rec.stop();
    expect(() => rec.recordPrompt("late")).toThrow();
    expect(() => rec.recordApproval("deny")).toThrow();
  });
});

describe("routine replay", () => {
  test("reproduces the exact sequence against a sink", () => {
    const rec = new RoutineRecorder();
    rec.start("scaffold-and-test");
    rec.recordPrompt("scaffold endpoint");
    rec.recordApproval("allow");
    rec.recordPrompt("run tests");
    const routine = rec.stop();

    const { sink, events } = makeSink();
    replayRoutine(routine, sink);

    expect(events).toEqual([
      "prompt:scaffold endpoint",
      "approval:allow",
      "prompt:run tests",
    ]);
  });

  test("replays an approval decision", () => {
    const routine: Routine = {
      name: "just-deny",
      steps: [{ kind: "approval", decision: "deny" }],
    };
    const { sink, events } = makeSink();
    replayRoutine(routine, sink);
    expect(events).toEqual(["approval:deny"]);
  });
});

describe("routine serialization", () => {
  test("serialize -> deserialize round-trips", () => {
    const routine: Routine = {
      name: "scaffold-and-test",
      steps: [
        { kind: "prompt", text: "scaffold endpoint" },
        { kind: "approval", decision: "allow" },
        { kind: "prompt", text: "run tests" },
      ],
    };
    const back = deserializeRoutine(serializeRoutine(routine));
    expect(back).toEqual(routine);
  });

  test("deserialize on malformed JSON throws", () => {
    expect(() => deserializeRoutine("{ not json")).toThrow();
  });

  test("deserialize on structurally invalid routine throws", () => {
    expect(() => deserializeRoutine(JSON.stringify({ name: "x" }))).toThrow();
    expect(() =>
      deserializeRoutine(JSON.stringify({ name: "x", steps: [{ kind: "bogus" }] })),
    ).toThrow();
  });
});
