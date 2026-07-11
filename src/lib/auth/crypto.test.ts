/**
 * Tests — YIL-4. Crypto primitives.
 *
 * Pure unit tests; no DB required.
 */
import { describe, it, expect } from "vitest";
import { generateToken, sha256Hex, constantTimeEqual } from "./crypto";

describe("generateToken", () => {
  it("returns a base64url string of the expected length", () => {
    const t = generateToken(32);
    // 32 bytes -> 43 chars base64url (no padding).
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("returns distinct values across calls", () => {
    const a = generateToken(32);
    const b = generateToken(32);
    expect(a).not.toBe(b);
  });
});

describe("sha256Hex", () => {
  it("is deterministic and 64 hex chars", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
    expect(sha256Hex("hello")).toMatch(/^[a-f0-9]{64}$/);
  });
  it("changes with input", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
  it("returns false for different lengths without throwing", () => {
    expect(constantTimeEqual("ab", "abc")).toBe(false);
  });
});