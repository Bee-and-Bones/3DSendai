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
