import { describe, expect, it } from "vitest";
import { matchesAny, redact, REDACT_PATHS } from "./redact";

describe("redact.matchesAny", () => {
  it("matches a literal path", () => {
    expect(matchesAny("password", REDACT_PATHS)).toBe(true);
    expect(matchesAny("user.password", REDACT_PATHS)).toBe(true);
  });

  it("matches a single-level wildcard", () => {
    expect(matchesAny("auth.token", REDACT_PATHS)).toBe(true);
    expect(matchesAny("payment.token", REDACT_PATHS)).toBe(true);
  });

  it("matches a substring wildcard", () => {
    expect(matchesAny("stripe_access_token", REDACT_PATHS)).toBe(true);
    expect(matchesAny("user.refreshToken", REDACT_PATHS)).toBe(true);
  });

  it("does not match unrelated fields", () => {
    expect(matchesAny("email", REDACT_PATHS)).toBe(false);
    expect(matchesAny("user.name", REDACT_PATHS)).toBe(false);
    expect(matchesAny("listing.title", REDACT_PATHS)).toBe(false);
  });
});

describe("redact.redact", () => {
  it("replaces matching fields with [redacted]", () => {
    const input = { user: { name: "alice", password: "hunter2" } };
    const out = redact(input, REDACT_PATHS);
    expect(out).toEqual({ user: { name: "alice", password: "[redacted]" } });
  });

  it("walks arrays", () => {
    const input = { users: [{ token: "abc" }, { token: "def" }] };
    const out = redact(input, REDACT_PATHS);
    expect(out).toEqual({ users: [{ token: "[redacted]" }, { token: "[redacted]" }] });
  });

  it("does not mutate the input", () => {
    const input = { password: "hunter2" };
    redact(input, REDACT_PATHS);
    expect(input.password).toBe("hunter2");
  });

  it("passes through primitives and null/undefined", () => {
    expect(redact(null, REDACT_PATHS)).toBeNull();
    expect(redact(undefined, REDACT_PATHS)).toBeUndefined();
    expect(redact("hello", REDACT_PATHS)).toBe("hello");
    expect(redact(42, REDACT_PATHS)).toBe(42);
  });

  it("accepts additional patterns from the env", () => {
    const out = redact({ apiKey: "sk_live_x", email: "x@y.z" }, [
      ...REDACT_PATHS,
      "*apiKey",
    ]);
    expect(out).toEqual({ apiKey: "[redacted]", email: "x@y.z" });
  });
});