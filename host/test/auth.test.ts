import { expect, test, describe } from "bun:test";
import { isLoopback, assertBindAllowed, verifyAttach } from "../src/server/auth.ts";

describe("auth", () => {
  test("recognizes loopback hosts", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.5")).toBe(false);
  });

  test("refuses a non-loopback bind without a token", () => {
    expect(() => assertBindAllowed("0.0.0.0", undefined)).toThrow(/non-loopback/);
    expect(() => assertBindAllowed("0.0.0.0", "tok")).not.toThrow();
    expect(() => assertBindAllowed("127.0.0.1", undefined)).not.toThrow();
  });

  test("verifyAttach enforces the configured token", () => {
    expect(verifyAttach(undefined, undefined).ok).toBe(true); // loopback dev
    expect(verifyAttach("secret", "secret").ok).toBe(true);
    expect(verifyAttach("secret", "wrong").ok).toBe(false);
    expect(verifyAttach("secret", undefined).ok).toBe(false);
    expect(verifyAttach("secret", undefined).reason).toMatch(/missing/);
  });
});
