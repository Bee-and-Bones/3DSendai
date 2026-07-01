// A framed connection over an abstract byte sink, with an ordered write queue
// that applies backpressure instead of dropping frames (deepening finding #14).

import { FrameDecoder, encodeFrame, type Frame } from "@agentbus/protocol";

/** A byte sink returns how many bytes it accepted (0 = fully backpressured). */
export interface ByteSink {
  write(bytes: Uint8Array): number;
}

export class Connection {
  private decoder = new FrameDecoder();
  private queue: Uint8Array = new Uint8Array(0);
  private closed = false;

  constructor(
    private readonly sink: ByteSink,
    private readonly onFrame: (frame: Frame, conn: Connection) => void,
  ) {}

  /** Feed inbound bytes; decode and dispatch complete frames. */
  feed(chunk: Uint8Array): void {
    if (this.closed) return;
    for (const frame of this.decoder.push(chunk)) {
      this.onFrame(frame, this);
    }
  }

  /** Enqueue a frame and try to flush. Never drops or reorders. */
  send(type: number, sessionId: number, payload: unknown): void {
    if (this.closed) return;
    this.queue = concat(this.queue, encodeFrame(type, sessionId, payload));
    this.flush();
  }

  /** Attempt to drain the queue into the sink. Call again on sink drain. */
  flush(): void {
    if (this.closed || this.queue.length === 0) return;
    const accepted = this.sink.write(this.queue);
    if (accepted >= this.queue.length) {
      this.queue = new Uint8Array(0);
    } else if (accepted > 0) {
      this.queue = this.queue.slice(accepted);
    }
  }

  /** The transport signalled it can accept more bytes. */
  onDrain(): void {
    this.flush();
  }

  get queuedBytes(): number {
    return this.queue.length;
  }

  close(): void {
    this.closed = true;
    this.queue = new Uint8Array(0);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
