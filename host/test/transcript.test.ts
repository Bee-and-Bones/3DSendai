import { expect, test, describe } from "bun:test";
import { TranscriptLog } from "../src/transcript/log.ts";
import { buildBiasList, biasPrompt } from "../src/transcript/corpus.ts";

describe("transcript log", () => {
  test("append then all()/forSession() return the record", () => {
    const log = new TranscriptLog();
    const rec = { sessionId: 1, ts: 100, transcript: "build with libctru" };
    log.append(rec);

    expect(log.all()).toEqual([rec]);
    expect(log.forSession(1)).toEqual([rec]);
    expect(log.forSession(2)).toEqual([]);
  });

  test("forSession filters by session id", () => {
    const log = new TranscriptLog();
    log.append({ sessionId: 1, ts: 1, transcript: "one" });
    log.append({ sessionId: 2, ts: 2, transcript: "two" });
    log.append({ sessionId: 1, ts: 3, transcript: "three" });

    expect(log.forSession(1).map((r) => r.transcript)).toEqual(["one", "three"]);
  });
});

describe("bias corpus", () => {
  test("surfaces a term that repeats and excludes a term seen once", () => {
    const log = new TranscriptLog();
    log.append({ sessionId: 1, ts: 1, transcript: "use libctru here" });
    log.append({ sessionId: 1, ts: 2, transcript: "libctru graphics setup" });
    log.append({ sessionId: 1, ts: 3, voiceText: "link against libctru finally" });

    const terms = buildBiasList(log);
    expect(terms).toContain("libctru"); // appears 3x
    expect(terms).not.toContain("finally"); // appears once
    expect(terms).not.toContain("graphics"); // appears once
  });

  test("filters out stopwords even when they repeat", () => {
    const log = new TranscriptLog();
    log.append({ sessionId: 1, ts: 1, transcript: "the citro2d and the mesh" });
    log.append({ sessionId: 1, ts: 2, transcript: "and the citro2d and the mesh" });

    const terms = buildBiasList(log);
    expect(terms).toContain("citro2d");
    expect(terms).toContain("mesh");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("and");
  });

  test("orders by frequency, most-frequent first", () => {
    const log = new TranscriptLog();
    log.append({ sessionId: 1, ts: 1, transcript: "libctru libctru libctru citro2d citro2d" });
    log.append({ sessionId: 1, ts: 2, transcript: "libctru citro2d" });

    const terms = buildBiasList(log);
    expect(terms[0]).toBe("libctru"); // 4x
    expect(terms[1]).toBe("citro2d"); // 3x
  });

  test("limit caps the returned list length", () => {
    const log = new TranscriptLog();
    // ten distinct terms, each appearing twice
    for (let i = 0; i < 10; i++) {
      log.append({ sessionId: 1, ts: i, transcript: `term${i} term${i}` });
    }

    const terms = buildBiasList(log, { limit: 3 });
    expect(terms).toHaveLength(3);
  });

  test("minCount option raises the recurrence threshold", () => {
    const log = new TranscriptLog();
    log.append({ sessionId: 1, ts: 1, transcript: "libctru libctru citro2d" });
    log.append({ sessionId: 1, ts: 2, transcript: "libctru citro2d" });

    const terms = buildBiasList(log, { minCount: 3 });
    expect(terms).toEqual(["libctru"]); // 3x survives, citro2d (2x) does not
  });

  test("biasPrompt contains the terms", () => {
    const prompt = biasPrompt(["libctru", "citro2d"]);
    expect(prompt).toContain("libctru");
    expect(prompt).toContain("citro2d");
    expect(prompt).toBe("Vocabulary: libctru, citro2d");
  });
});
