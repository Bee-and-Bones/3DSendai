// U12 (plan-004): AUDIO_CHUNK -> transcript -> injection. Buffers the
// device-rate PCM of one push-to-talk utterance until the final chunk
// (KTD4: record-then-transcribe — the whole utterance resamples in one pass,
// no chunk-seam artifacts), then transcribes once via the AudioIngest seam and
// injects the text into the focused pane through the caller-supplied seam
// (the tmux bridge's send-keys path). An empty/silent utterance injects
// nothing. The final transcript is echoed back as TRANSCRIPT_PARTIAL for
// on-device confirmation.

import { AudioIngest } from "./ingest.ts";
import type { Stt } from "./stt.ts";

export interface AudioChunkPayload {
  sessionId: number;
  hex: string;
  final?: boolean;
}

export interface VoiceRouteOptions {
  stt: Stt;
  /** Inject the recognized text into a session (bridge send-keys path). */
  inject: (sessionId: number, text: string) => void;
  /** Echo the final transcript to the device (TRANSCRIPT_PARTIAL). */
  echo?: (sessionId: number, text: string) => void;
}

export class VoiceRoute {
  private readonly stt: Stt;
  private readonly inject: (sessionId: number, text: string) => void;
  private readonly echo: ((sessionId: number, text: string) => void) | undefined;
  private pcm: Int16Array[] = [];

  constructor(opts: VoiceRouteOptions) {
    this.stt = opts.stt;
    this.inject = opts.inject;
    this.echo = opts.echo;
  }

  /** Route one AUDIO_CHUNK frame. Returns the final transcript when done. */
  handleChunk(payload: AudioChunkPayload): string | undefined {
    const bytes = hexToBytes(payload.hex ?? "");
    if (bytes.length >= 2) {
      // PCM16 little-endian on the wire (device memory order).
      this.pcm.push(new Int16Array(bytes.buffer, 0, bytes.length >> 1));
    }
    if (!payload.final) return undefined;

    // Utterance complete: one resample + one transcription (KTD4).
    const total = this.pcm.reduce((n, c) => n + c.length, 0);
    const all = new Int16Array(total);
    let off = 0;
    for (const c of this.pcm) {
      all.set(c, off);
      off += c.length;
    }
    this.pcm = [];

    const ingest = new AudioIngest({ stt: this.stt, onPartial: () => {} });
    if (all.length > 0) ingest.pushChunk(all);
    const text = ingest.end();
    this.stt.reset();
    if (text.length > 0) {
      this.inject(payload.sessionId, text);
      this.echo?.(payload.sessionId, text);
    }
    return text;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    out[i] = Number.isNaN(b) ? 0 : b;
  }
  return out;
}
