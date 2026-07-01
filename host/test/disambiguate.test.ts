import { expect, test, describe } from "bun:test";
import { RepoIndex } from "../src/index/repo-index.ts";
import { disambiguate } from "../src/index/disambiguate.ts";

const PATHS = ["middleware/auth.ts", "utils/format.ts", "README.md", "test/auth.test.ts"];

describe("repo-grounded disambiguation (AE3)", () => {
  test("ranks the real file for a whisper-style phrase, not the raw string", () => {
    const index = RepoIndex.fromPaths(PATHS);
    const result = disambiguate(index, "open the auth handler");

    const paths = result.map((b) => b.id);
    expect(paths).toContain("middleware/auth.ts");
    // The transcript itself is never returned verbatim.
    expect(paths).not.toContain("open the auth handler");
    // Among the auth matches, the source file outranks the test file.
    const authIdx = paths.indexOf("middleware/auth.ts");
    const testIdx = paths.indexOf("test/auth.test.ts");
    if (testIdx !== -1) expect(authIdx).toBeLessThan(testIdx);
  });

  test("an exact basename spoken ranks that file first", () => {
    const index = RepoIndex.fromPaths(PATHS);
    const result = disambiguate(index, "open format");
    expect(result[0]?.id).toBe("utils/format.ts");
  });

  test("empty index returns no candidates", () => {
    const index = RepoIndex.fromPaths([]);
    expect(disambiguate(index, "open the auth handler")).toEqual([]);
  });

  test("a transcript matching nothing returns no candidates", () => {
    const index = RepoIndex.fromPaths(PATHS);
    expect(disambiguate(index, "make me a sandwich")).toEqual([]);
  });

  test("returned items are MacropadButtons with open intents", () => {
    const index = RepoIndex.fromPaths(PATHS);
    const result = disambiguate(index, "open format");
    expect(result.length).toBeGreaterThan(0);
    for (const button of result) {
      expect(typeof button.id).toBe("string");
      expect(button.id.length).toBeGreaterThan(0);
      expect(typeof button.label).toBe("string");
      expect(button.label.length).toBeGreaterThan(0);
      expect(button.intent?.startsWith("open:")).toBe(true);
    }
    expect(result[0]?.label).toBe("format.ts");
    expect(result[0]?.intent).toBe("open:utils/format.ts");
  });
});
