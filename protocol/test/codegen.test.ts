import { expect, test } from "bun:test";
import { generated } from "../codegen/generate.ts";

// Enum-parity guard (finding #9): regenerate in-memory and fail if the
// committed TS enum or C header drifted from the single source of truth.
test("generated TS enum matches committed file", async () => {
  const committed = await Bun.file(generated.tsPath).text();
  expect(committed).toBe(generated.ts());
});

test("generated C header matches committed file", async () => {
  const committed = await Bun.file(generated.hPath).text();
  expect(committed).toBe(generated.h());
});

test("generated crypto constants match committed file", async () => {
  const committed = await Bun.file(generated.constTsPath).text();
  expect(committed).toBe(generated.constTs());
});
