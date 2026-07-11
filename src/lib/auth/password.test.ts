/**
 * Tests — YIL-4. Password hashing wrapper around bcryptjs.
 *
 * Pure unit tests; no DB required.
 */
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, BCRYPT_COST } from "./password";

describe("password hashing", () => {
  it("hashes and verifies a password round-trip", async () => {
    const hash = await hashPassword("correct horse battery 9");
    expect(hash).not.toEqual("correct horse battery 9");
    expect(hash.length).toBeGreaterThan(50);
    expect(await verifyPassword("correct horse battery 9", hash)).toBe(true);
  });

  it("returns false for the wrong password", async () => {
    const hash = await hashPassword("correct horse battery 9");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects empty input on hash", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });

  it("returns false on null/undefined hash", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", undefined)).toBe(false);
  });

  it("uses the documented cost factor", () => {
    expect(BCRYPT_COST).toBe(12);
  });
});