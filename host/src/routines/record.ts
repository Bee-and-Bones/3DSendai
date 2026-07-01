// Record a multi-turn sequence of prompts + approvals as a named routine
// (U21, R23). The recorder captures the ordered steps a user drove during a
// session so they can be replayed later (see replay.ts).

export type RoutineStep =
  | { kind: "prompt"; text: string }
  | { kind: "approval"; decision: "allow" | "deny" };

export interface Routine {
  name: string;
  steps: RoutineStep[];
}

export class RoutineRecorder {
  private name: string | null = null;
  private steps: RoutineStep[] = [];
  private stopped = false;

  start(name: string): void {
    if (this.name !== null) {
      throw new Error("RoutineRecorder: already started");
    }
    this.name = name;
    this.steps = [];
    this.stopped = false;
  }

  recordPrompt(text: string): void {
    this.assertRecording();
    this.steps.push({ kind: "prompt", text });
  }

  recordApproval(decision: "allow" | "deny"): void {
    this.assertRecording();
    this.steps.push({ kind: "approval", decision });
  }

  stop(): Routine {
    if (this.name === null) {
      throw new Error("RoutineRecorder: stop() called before start()");
    }
    if (this.stopped) {
      throw new Error("RoutineRecorder: already stopped");
    }
    this.stopped = true;
    return { name: this.name, steps: this.steps };
  }

  private assertRecording(): void {
    if (this.name === null) {
      throw new Error("RoutineRecorder: record called before start()");
    }
    if (this.stopped) {
      throw new Error("RoutineRecorder: record called after stop()");
    }
  }
}
