// Durable output buffer for reconnect/replay (U18, R5). The host owns a bounded
// log of emitted frames; on reconnect the device asks for everything after a
// cursor. If the disconnect outran the buffer, replay is flagged truncated
// instead of silently losing data (deepening finding #13).

export interface RecordedFrame {
  seq: number;
  type: number;
  sessionId: number;
  payload: unknown;
}

export interface ReplayResult {
  frames: RecordedFrame[];
  truncated: boolean;
  latest: number;
}

export class DurableBuffer {
  private items: RecordedFrame[] = [];
  private seq = 0;

  constructor(private readonly capacity = 1000) {}

  record(type: number, sessionId: number, payload: unknown): number {
    this.seq += 1;
    this.items.push({ seq: this.seq, type, sessionId, payload });
    if (this.items.length > this.capacity) this.items.shift();
    return this.seq;
  }

  get latest(): number {
    return this.seq;
  }

  /** Frames strictly after `cursor`, plus whether older frames were dropped. */
  replaySince(cursor: number): ReplayResult {
    const oldest = this.items[0]?.seq;
    const truncated = oldest === undefined ? this.seq > cursor : oldest > cursor + 1;
    const frames = this.items.filter((f) => f.seq > cursor);
    return { frames, truncated, latest: this.seq };
  }
}
