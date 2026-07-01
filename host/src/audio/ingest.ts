// Audio ingest pipeline (U14/U15). Takes device-rate PCM off the wire, resamples
// it to whisper's required 16kHz, feeds STT, and streams partials to the caller.
// end() flushes a final transcript. This is the host seam between the mic capture
// and whatever consumes the recognized prompt.

import { DEVICE_SAMPLE_RATE, WHISPER_SAMPLE_RATE, resampleLinear } from "./resample.ts";
import type { Stt } from "./stt.ts";

export interface AudioIngestOptions {
  stt: Stt;
  /** Called with the growing transcript; final=true on end(). */
  onPartial: (text: string, final: boolean) => void;
}

export class AudioIngest {
  private readonly stt: Stt;
  private readonly onPartial: (text: string, final: boolean) => void;

  constructor(options: AudioIngestOptions) {
    this.stt = options.stt;
    this.onPartial = options.onPartial;
  }

  /** Ingest one device-rate PCM chunk: resample -> feed STT -> emit partial. */
  pushChunk(pcm: Int16Array): void {
    const resampled = resampleLinear(pcm, DEVICE_SAMPLE_RATE, WHISPER_SAMPLE_RATE);
    this.stt.feed(resampled);
    this.onPartial(this.stt.partials(), false);
  }

  /** Flush: emit the final transcript ("" if no audio was ever ingested). */
  end(): string {
    const text = this.stt.finalize();
    this.onPartial(text, true);
    return text;
  }
}
