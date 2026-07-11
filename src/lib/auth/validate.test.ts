/**
 * Tests — YIL-4. Validation schemas.
 */
import { describe, it, expect } from "vitest";
import {
  registerSchema,
  loginSchema,
  passwordSchema,
  emailSchema,
} from "./validate";

describe("emailSchema", () => {
  it("lowercases and accepts a normal address", () => {
    expect(emailSchema.parse("Alice@Example.COM")).toBe("alice@example.com");
  });
  it("rejects malformed addresses", () => {
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(emailSchema.safeParse("").success).toBe(false);
    expect(emailSchema.safeParse("a@b").success).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("accepts passwords ≥10 with letter+digit", () => {
    expect(passwordSchema.safeParse("longerstring1").success).toBe(true);
  });
  it("rejects too-short", () => {
    expect(passwordSchema.safeParse("short1").success).toBe(false);
  });
  it("rejects missing letter", () => {
    expect(passwordSchema.safeParse("1234567890").success).toBe(false);
  });
  it("rejects missing digit", () => {
    expect(passwordSchema.safeParse("onlylettershere").success).toBe(false);
  });
});

describe("registerSchema", () => {
  it("requires email + password", () => {
    expect(registerSchema.safeParse({}).success).toBe(false);
    expect(
      registerSchema.safeParse({
        email: "a@example.com",
        password: "longerstring1",
      }).success
    ).toBe(true);
  });
  it("trims and lowercases email", () => {
    const parsed = registerSchema.parse({
      email: "  Alice@Example.COM  ",
      password: "longerstring1",
    });
    expect(parsed.email).toBe("alice@example.com");
  });
});

describe("loginSchema", () => {
  it("accepts email + any non-empty password (length is bcrypt's job)", () => {
    expect(
      loginSchema.safeParse({
        email: "a@example.com",
        password: "x",
      }).success
    ).toBe(true);
  });
});