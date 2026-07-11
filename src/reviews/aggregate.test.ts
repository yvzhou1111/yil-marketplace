import { describe, it, expect } from "vitest";
import { aggregateReviews, formatRatingDisplay } from "./aggregate";

describe("aggregateReviews", () => {
  it("returns zeros and null avg for an empty list", () => {
    const agg = aggregateReviews([]);
    expect(agg).toEqual({
      total: 0,
      visible: 0,
      hidden: 0,
      ratingAvg: null,
      rating1: 0,
      rating2: 0,
      rating3: 0,
      rating4: 0,
      rating5: 0,
    });
  });

  it("counts visible reviews and averages only those", () => {
    const rows = [
      { rating: 5, hiddenAt: null },
      { rating: 4, hiddenAt: null },
      { rating: 3, hiddenAt: null },
    ];
    const agg = aggregateReviews(rows);
    expect(agg.visible).toBe(3);
    expect(agg.hidden).toBe(0);
    expect(agg.total).toBe(3);
    expect(agg.ratingAvg).toBeCloseTo(4, 5);
    expect(agg.rating1).toBe(0);
    expect(agg.rating5).toBe(1);
  });

  it("excludes hidden reviews from the average", () => {
    const rows = [
      { rating: 5, hiddenAt: null },
      { rating: 1, hiddenAt: null },
      // Hidden review must NOT poison the average.
      { rating: 1, hiddenAt: new Date("2026-01-01") },
    ];
    const agg = aggregateReviews(rows);
    expect(agg.visible).toBe(2);
    expect(agg.hidden).toBe(1);
    expect(agg.total).toBe(3);
    expect(agg.ratingAvg).toBeCloseTo(3, 5);
  });

  it("returns null average when every review is hidden", () => {
    const rows = [
      { rating: 1, hiddenAt: new Date("2026-01-01") },
      { rating: 5, hiddenAt: new Date("2026-02-01") },
    ];
    const agg = aggregateReviews(rows);
    expect(agg.visible).toBe(0);
    expect(agg.hidden).toBe(2);
    expect(agg.ratingAvg).toBeNull();
  });

  it("populates rating buckets", () => {
    const rows = [
      { rating: 1, hiddenAt: null },
      { rating: 1, hiddenAt: null },
      { rating: 3, hiddenAt: null },
      { rating: 5, hiddenAt: null },
    ];
    const agg = aggregateReviews(rows);
    expect(agg.rating1).toBe(2);
    expect(agg.rating2).toBe(0);
    expect(agg.rating3).toBe(1);
    expect(agg.rating4).toBe(0);
    expect(agg.rating5).toBe(1);
  });
});

describe("formatRatingDisplay", () => {
  it("em-dashes when there are no visible reviews", () => {
    const agg = aggregateReviews([]);
    expect(formatRatingDisplay(agg)).toBe("—");
  });
  it("rounds to one decimal", () => {
    const agg = aggregateReviews([
      { rating: 4, hiddenAt: null },
      { rating: 5, hiddenAt: null },
    ]);
    expect(formatRatingDisplay(agg)).toBe("4.5");
  });
});