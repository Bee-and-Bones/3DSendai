import { expect, test, describe } from "bun:test";
import {
  DEVICE_SAMPLE_RATE,
  WHISPER_SAMPLE_RATE,
  resampleLinear,
} from "../src/audio/resample.ts";
import { FakeStt } from "../src/audio/stt.ts";
import { AudioIngest } from "../src/audio/ingest.ts";

const finite = (arr: Int16Array) => Array.from(arr).every((v) => Number.isFinite(v));

describe("resampleLinear", () => {
  test("device rate -> 16kHz hits expected length and stays finite", () => {
    const input = new Int16Array(1000);
    for (let i = 0; i < input.length; i++) input[i] = Math.round(Math.sin(i / 5) * 10000);

    const out = resampleLinear(input, DEVICE_SAMPLE_RATE, WHISPER_SAMPLE_RATE);
    const expected = Math.round(input.length * (WHISPER_SAMPLE_RATE / DEVICE_SAMPLE_RATE));

    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(1);
    expect(finite(out)).toBe(true);
  });

  test("empty input yields empty output", () => {
    expect(resampleLinear(new Int16Array(0), DEVICE_SAMPLE_RATE, WHISPER_SAMPLE_RATE).length).toBe(0);
  });

  test("identity when fromRate === toRate", () => {
    const input = new Int16Array([1, -2, 3, -4, 5]);
    const out = resampleLinear(input, WHISPER_SAMPLE_RATE, WHISPER_SAMPLE_RATE);
    expect(out.length).toBe(input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });
});

describe("AudioIngest", () => {
  const chunk = () => {
    const c = new Int16Array(500);
    for (let i = 0; i < c.length; i++) c[i] = Math.round(Math.sin(i / 3) * 8000);
    return c;
  };

  test("emits interim partials then a final carrying the transcript", () => {
    const events: Array<{ text: string; final: boolean }> = [];
    const ingest = new AudioIngest({
      stt: new FakeStt("run the tests please"),
      onPartial: (text, final) => events.push({ text, final }),
    });

    ingest.pushChunk(chunk());
    ingest.pushChunk(chunk());
    ingest.pushChunk(chunk());
    const finalText = ingest.end();

    const partials = events.filter((e) => !e.final);
    const finals = events.filter((e) => e.final);

    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials.some((p) => p.text.length > 0)).toBe(true);
    expect(finals.length).toBe(1);
    expect(finals[0]?.text).toBe("run the tests please");
    expect(finalText).toBe("run the tests please");
  });

  test("end() with no chunks emits final \"\" and does not throw", () => {
    const events: Array<{ text: string; final: boolean }> = [];
    const ingest = new AudioIngest({
      stt: new FakeStt("ignored"),
      onPartial: (text, final) => events.push({ text, final }),
    });

    const finalText = ingest.end();

    expect(finalText).toBe("");
    expect(events).toEqual([{ text: "", final: true }]);
  });

  test("empty/silent chunk does not crash and yields empty partial", () => {
    const events: Array<{ text: string; final: boolean }> = [];
    const ingest = new AudioIngest({
      stt: new FakeStt("something"),
      onPartial: (text, final) => events.push({ text, final }),
    });

    ingest.pushChunk(new Int16Array(0));

    expect(events).toEqual([{ text: "", final: false }]);
  });
});

// --- U12 (plan-004): voice route + whisper backend selection -----------------

import { VoiceRoute } from "../src/audio/voice.ts";
import { WhisperStt, sttFromEnv, wavFromPcm16 } from "../src/audio/whisperStt.ts";
import type { Stt } from "../src/audio/stt.ts";

function pcmHex(samples: number[]): string {
  const bytes = new Uint8Array(new Int16Array(samples).buffer);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

describe("VoiceRoute (U12)", () => {
  test("buffered utterance finalizes to the scripted transcript and injects via the bridge seam", () => {
    const injected: Array<{ sessionId: number; text: string }> = [];
    const echoed: Array<{ sessionId: number; text: string }> = [];
    const v = new VoiceRoute({
      stt: new FakeStt("run the tests"),
      inject: (sessionId, text) => injected.push({ sessionId, text }),
      echo: (sessionId, text) => echoed.push({ sessionId, text }),
    });
    v.handleChunk({ sessionId: 2, hex: pcmHex([100, -100, 200, -200]), final: false });
    v.handleChunk({ sessionId: 2, hex: pcmHex([300, -300]), final: false });
    expect(injected.length).toBe(0); // nothing until release
    const text = v.handleChunk({ sessionId: 2, hex: "", final: true });
    expect(text).toBe("run the tests");
    expect(injected).toEqual([{ sessionId: 2, text: "run the tests" }]);
    expect(echoed).toEqual([{ sessionId: 2, text: "run the tests" }]);
  });

  test("a silent (empty) utterance yields empty text and no spurious injection", () => {
    const injected: string[] = [];
    const v = new VoiceRoute({ stt: new FakeStt("should never appear"), inject: (_s, t) => injected.push(t) });
    const text = v.handleChunk({ sessionId: 1, hex: "", final: true });
    expect(text).toBe("");
    expect(injected).toEqual([]);
  });

  test("the final chunk triggers exactly one transcription; state resets between utterances", () => {
    let finalizes = 0;
    const counting: Stt = {
      feed() {},
      partials: () => "",
      finalize: () => {
        finalizes++;
        return "one";
      },
      reset() {},
    };
    const injected: string[] = [];
    const v = new VoiceRoute({ stt: counting, inject: (_s, t) => injected.push(t) });
    v.handleChunk({ sessionId: 1, hex: pcmHex([1, 2, 3]), final: false });
    v.handleChunk({ sessionId: 1, hex: pcmHex([4, 5]), final: false });
    v.handleChunk({ sessionId: 1, hex: pcmHex([6]), final: true });
    expect(finalizes).toBe(1);
    // Second utterance transcribes independently.
    v.handleChunk({ sessionId: 1, hex: pcmHex([7]), final: true });
    expect(finalizes).toBe(2);
    expect(injected).toEqual(["one", "one"]);
  });
});

describe("whisper backend selection (U12/KTD5)", () => {
  test("default env selects FakeStt — no model needed", () => {
    expect(sttFromEnv({}) instanceof FakeStt).toBe(true);
    expect(sttFromEnv({ SENDAI_STT: "off" }) instanceof FakeStt).toBe(true);
  });

  test("SENDAI_STT=whisper selects the real backend (constructed, not invoked)", () => {
    const stt = sttFromEnv({ SENDAI_STT: "whisper", SENDAI_WHISPER_MODEL: "/models/ggml-base.en.bin" });
    expect(stt instanceof WhisperStt).toBe(true);
    expect(stt.partials()).toBe(""); // record-then-transcribe: no interim results
    expect(stt.finalize()).toBe(""); // no audio fed -> empty, without touching the CLI
  });
});

describe("wavFromPcm16 (U12)", () => {
  test("header fields for 16kHz mono 16-bit are byte-correct", () => {
    const wav = wavFromPcm16(new Int16Array([0, 1000, -1000]), 16000);
    const v = new DataView(wav.buffer);
    const ascii = (off: number, n: number) => new TextDecoder().decode(wav.subarray(off, off + n));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(34, true)).toBe(16); // bits/sample
    expect(v.getUint32(40, true)).toBe(6); // data bytes
    expect(v.getInt16(44 + 2, true)).toBe(1000);
    expect(v.getInt16(44 + 4, true)).toBe(-1000);
  });
});

describe("VoiceRoute session switch (Phase 3 verifier nit)", () => {
  test("a focus change mid-utterance drops the stale PCM instead of merging it", () => {
    let fed = 0;
    const counting: Stt = {
      feed(pcm) { fed += pcm.length; },
      partials: () => "",
      finalize: () => "x",
      reset() {},
    };
    const v = new VoiceRoute({ stt: counting, inject: () => {} });
    v.handleChunk({ sessionId: 1, hex: pcmHex([1, 2, 3, 4]), final: false }); // orphaned: no final
    v.handleChunk({ sessionId: 2, hex: pcmHex([5, 6]), final: false });
    v.handleChunk({ sessionId: 2, hex: "", final: true });
    // Only session 2's 2 samples reach STT; the resampler shortens ~2%, so
    // assert it's the short utterance, not the merged 6 samples.
    expect(fed).toBeLessThanOrEqual(2);
    expect(fed).toBeGreaterThan(0);
  });
});
