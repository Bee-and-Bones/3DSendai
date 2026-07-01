// Replay and (de)serialize recorded routines (U21, R23). Replay drives each
// step in order against a sink; serialize/deserialize let a routine be stored
// and loaded, validating on the way back in so a malformed blob fails loudly.

import type { Routine, RoutineStep } from "./record.ts";
export type { Routine, RoutineStep } from "./record.ts";

export interface RoutineSink {
  prompt(text: string): void;
  approval(decision: "allow" | "deny"): void;
}

export function replayRoutine(routine: Routine, sink: RoutineSink): void {
  for (const step of routine.steps) {
    if (step.kind === "prompt") {
      sink.prompt(step.text);
    } else {
      sink.approval(step.decision);
    }
  }
}

export function serializeRoutine(r: Routine): string {
  return JSON.stringify(r);
}

export function deserializeRoutine(text: string): Routine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("deserializeRoutine: invalid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("deserializeRoutine: routine must be an object");
  }
  if (typeof parsed.name !== "string") {
    throw new Error("deserializeRoutine: routine.name must be a string");
  }
  if (!Array.isArray(parsed.steps)) {
    throw new Error("deserializeRoutine: routine.steps must be an array");
  }
  const steps = parsed.steps.map(parseStep);
  return { name: parsed.name, steps };
}

function parseStep(step: unknown, i: number): RoutineStep {
  if (!isRecord(step)) {
    throw new Error(`deserializeRoutine: step ${i} must be an object`);
  }
  if (step.kind === "prompt") {
    if (typeof step.text !== "string") {
      throw new Error(`deserializeRoutine: step ${i} prompt.text must be a string`);
    }
    return { kind: "prompt", text: step.text };
  }
  if (step.kind === "approval") {
    if (step.decision !== "allow" && step.decision !== "deny") {
      throw new Error(`deserializeRoutine: step ${i} approval.decision must be "allow" or "deny"`);
    }
    return { kind: "approval", decision: step.decision };
  }
  throw new Error(`deserializeRoutine: step ${i} has unknown kind`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
