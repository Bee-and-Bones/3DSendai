// Per-session transcript log (U22, R24). The host keeps a structured record of
// what was heard, what macro ran, and what came back, so a session can be
// replayed for debugging and mined as an STT bias corpus (see corpus.ts) —
// whisper picks up domain vocab that keeps recurring. In-memory only; the caller
// stamps `ts` (do not read the clock here) and is free to persist toJSONL().

export interface TranscriptRecord {
  sessionId: number;
  ts: number;
  voiceText?: string;
  transcript?: string;
  macro?: string;
  output?: string;
  outcome?: string;
}

export class TranscriptLog {
  private records: TranscriptRecord[] = [];

  append(record: TranscriptRecord): void {
    this.records.push(record);
  }

  all(): TranscriptRecord[] {
    return this.records.slice();
  }

  forSession(id: number): TranscriptRecord[] {
    return this.records.filter((r) => r.sessionId === id);
  }

  /** One JSON object per line, oldest first. Handy for durable append-only files. */
  toJSONL(): string {
    return this.records.map((r) => JSON.stringify(r)).join("\n");
  }
}
