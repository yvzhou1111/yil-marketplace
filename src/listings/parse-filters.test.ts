import { describe, expect, it } from "vitest";
import { BROWSE_LIMITS } from "./types";
import { buildFiltersQuery, parseFilters } from "./parse-filters";

function usp(qs: string): URLSearchParams {
  return new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
}

describe("parseFilters", () => {
  it("returns empty filters when no params are present", () => {
    expect(parseFilters(usp(""))).toEqual({});
  });

  it("parses a single category slug", () => {
    expect(parseFilters(usp("category=electronics"))).toEqual({
      categorySlugs: ["electronics"],
    });
  });

  it("parses multiple comma-separated slugs", () => {
    expect(parseFilters(usp("category=books,music"))).toEqual({
      categorySlugs: ["books", "music"],
    });
  });

  it("parses price range from dollar strings", () => {
    expect(parseFilters(usp("priceMin=10&priceMax=99"))).toEqual({
      priceMinCents: 1000,
      priceMaxCents: 9900,
    });
  });

  it("drops invalid price strings silently", () => {
    expect(parseFilters(usp("priceMin=abc"))).toEqual({});
  });

  it("drops inverted ranges", () => {
    expect(parseFilters(usp("priceMin=100&priceMax=10"))).toEqual({});
  });

  it("clamps price to the configured max", () => {
    const f = parseFilters(usp("priceMin=999999999"));
    expect(f.priceMinCents).toBe(BROWSE_LIMITS.priceMaxCents);
  });

  it("parses location as a free-text string", () => {
    expect(parseFilters(usp("location=Brooklyn"))).toEqual({
      location: "Brooklyn",
    });
  });

  it("parses page and pageSize as positive integers", () => {
    expect(parseFilters(usp("page=3&pageSize=12"))).toEqual({
      page: 3,
      pageSize: 12,
    });
  });

  it("rejects out-of-range page numbers", () => {
    expect(parseFilters(usp(`page=${BROWSE_LIMITS.pageMax + 1}`))).toEqual({});
  });

  it("returns permissive defaults on completely garbage input", () => {
    // The whole point: filter URLs get shared, so we shouldn't 500.
    expect(parseFilters(usp("page=foo&priceMin=&category="))).toEqual({});
  });
});

describe("buildFiltersQuery", () => {
  it("returns empty string for empty filters", () => {
    expect(buildFiltersQuery({})).toBe("");
  });

  it("round-trips a populated filter set", () => {
    const qs = buildFiltersQuery({
      categorySlugs: ["books", "music"],
      priceMinCents: 1000,
      priceMaxCents: 9900,
      location: "Brooklyn",
    });
    const reparsed = parseFilters(usp(qs));
    expect(reparsed).toEqual({
      categorySlugs: ["books", "music"],
      priceMinCents: 1000,
      priceMaxCents: 9900,
      location: "Brooklyn",
    });
  });

  it("omits page=1 (the default)", () => {
    expect(buildFiltersQuery({ page: 1 })).toBe("");
  });
});