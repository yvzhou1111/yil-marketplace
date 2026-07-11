import { describe, expect, it } from "vitest";
import {
  escapeLikePattern,
  formatMemberSince,
  formatMoney,
  formatRelativePostedAt,
  normalizeLocation,
  parseCategoryParam,
  parsePriceToCents,
} from "./format";

describe("formatMoney", () => {
  it("renders USD as $1,234.56", () => {
    expect(formatMoney(123456, "USD")).toBe("$1,234.56");
  });

  it("renders zero USD as $0.00", () => {
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });

  it("rounds negative cents against the user — never throws", () => {
    expect(formatMoney(-1, "USD")).toBe("-$0.01");
  });

  it("falls back gracefully for unknown currency codes", () => {
    // `XX` is reserved as "no currency" by ISO 4217 and is rejected by
    // Intl.NumberFormat, which forces our fallback branch.
    expect(formatMoney(999, "XX")).toBe("9.99 XX");
  });

  it("renders EUR with the euro sign", () => {
    expect(formatMoney(4200, "EUR")).toMatch(/€/);
  });
});

describe("parsePriceToCents", () => {
  it("parses whole dollars", () => {
    expect(parsePriceToCents("1200")).toBe(120_000);
  });

  it("parses dollars and cents", () => {
    expect(parsePriceToCents("12.50")).toBe(1_250);
  });

  it("strips currency symbols and commas", () => {
    expect(parsePriceToCents("$1,250.00")).toBe(125_000);
  });

  it("trims whitespace", () => {
    expect(parsePriceToCents("  9 ")).toBe(900);
  });

  it("returns null for empty / whitespace / garbage", () => {
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents("   ")).toBeNull();
    expect(parsePriceToCents("abc")).toBeNull();
    expect(parsePriceToCents("1.234")).toBeNull(); // > 2dp
  });
});

describe("parseCategoryParam", () => {
  it("returns empty for null / empty", () => {
    expect(parseCategoryParam(null)).toEqual([]);
    expect(parseCategoryParam("")).toEqual([]);
    expect(parseCategoryParam(undefined)).toEqual([]);
  });

  it("splits, trims, dedupes, and lowercases", () => {
    expect(parseCategoryParam("books, electronics, books")).toEqual([
      "books",
      "electronics",
    ]);
  });

  it("drops empty entries", () => {
    expect(parseCategoryParam(" books ,, electronics ,")).toEqual([
      "books",
      "electronics",
    ]);
  });
});

describe("escapeLikePattern", () => {
  it("escapes % and _", () => {
    expect(escapeLikePattern("100% off_now")).toBe("100\\% off\\_now");
  });

  it("escapes backslashes first", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves plain strings untouched", () => {
    expect(escapeLikePattern("Brooklyn, NY")).toBe("Brooklyn, NY");
  });
});

describe("normalizeLocation", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeLocation("  Brooklyn,   NY  ")).toBe("Brooklyn, NY");
  });
});

describe("formatMemberSince", () => {
  it("formats ISO date as Month YYYY", () => {
    expect(formatMemberSince("2024-03-15T10:00:00.000Z")).toMatch(
      /March 2024/
    );
  });

  it("returns empty string on garbage input", () => {
    expect(formatMemberSince("not-a-date")).toBe("");
  });
});

describe("formatRelativePostedAt", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");

  it("shows just now for sub-minute deltas", () => {
    expect(formatRelativePostedAt("2026-07-11T11:59:30.000Z", now)).toBe("just now");
  });

  it("shows minutes for sub-hour deltas", () => {
    expect(formatRelativePostedAt("2026-07-11T11:55:00.000Z", now)).toBe("5m ago");
  });

  it("shows days for sub-month deltas", () => {
    expect(formatRelativePostedAt("2026-07-08T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("shows months for sub-year deltas", () => {
    expect(formatRelativePostedAt("2026-04-15T12:00:00.000Z", now)).toMatch(/mo ago/);
  });

  it("handles future dates as just now", () => {
    expect(formatRelativePostedAt("2026-07-12T12:00:00.000Z", now)).toBe("just now");
  });
});
