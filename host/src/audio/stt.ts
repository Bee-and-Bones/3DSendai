// Speech-to-text seam (U15). AudioIngest depends on this interface, not on any
// concrete engine, so a real whisper backend and the test fake are drop-in
// interchangeable. The fake emits a growing partial as PCM arrives, which mirrors
// how a streaming recognizer surfaces interim results.

export interface Stt {
  /** Feed a chunk of 16kHz mono PCM. */
  feed(pcm: Int16Array): void;
  /** Current best-guess interim transcript. */
  partials(): string;
  /** Flush and return the final transcript. */
  finalize(): string;
  /** Discard all state for reuse. */
  reset(): void;
}

export type SttFactory = () => Stt;

/**
 * Test double: constructed with a scripted transcript. As PCM is fed it reveals
 * more of that transcript (word by word) as a growing partial; finalize() returns
 * the full scripted text. With no PCM fed, partials() and finalize() are "".
 */
export class FakeStt implements Stt {
  private readonly words: string[];
  private fedChunks = 0;

  constructor(private readonly transcript: string) {
    this.words = transcript.length > 0 ? transcript.split(/\s+/).filter((w) => w.length > 0) : [];
  }

  feed(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    this.fedChunks++;
  }

  partials(): string {
    if (this.fedChunks === 0 || this.words.length === 0) return "";
    const revealed = Math.min(this.fedChunks, this.words.length);
    return this.words.slice(0, revealed).join(" ");
  }

  finalize(): string {
    if (this.fedChunks === 0) return "";
    return this.transcript;
  }

  reset(): void {
    this.fedChunks = 0;
  }
}
