import { describe, expect, it } from "vitest";
import { hello } from "./hello";

describe("hello", () => {
  it("returns a greeting for a name", () => {
    expect(hello("world")).toBe("Hello, world!");
  });

  it("trims whitespace", () => {
    expect(hello("  market  ")).toBe("Hello, market!");
  });

  it("throws on empty input", () => {
    expect(() => hello("   ")).toThrow(/must not be empty/);
  });
});