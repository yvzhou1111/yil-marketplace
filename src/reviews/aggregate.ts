/**
 * Pure aggregation helpers for reviews.
 *
 * Kept DB-agnostic so we can unit-test the math. The SQL helper
 * `reviews_aggregate_for_user` in migration 0002 returns the same shape
 * for query-time use.
 */

export interface ReviewAggregate {
  total: number;
  visible: number;
  hidden: number;
  /** null when there are no visible reviews. */
  ratingAvg: number | null;
  rating1: number;
  rating2: number;
  rating3: number;
  rating4: number;
  rating5: number;
}

export interface ReviewForAggregation {
  rating: number;
  hiddenAt: Date | null;
}

/**
 * Aggregate a list of reviews into a public-rating summary.
 *
 * The `hiddenAt IS NULL` filter is critical: a moderator-hidden review
 * must not poison the user's public average. We still count it in `total`
 * and `hidden` so moderators see the breakdown.
 */
export function aggregateReviews(
  rows: ReadonlyArray<ReviewForAggregation>
): ReviewAggregate {
  let visible = 0;
  let hidden = 0;
  let sum = 0;
  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (const row of rows) {
    if (row.hiddenAt) {
      hidden += 1;
      continue;
    }
    visible += 1;
    sum += row.rating;
    buckets[row.rating as 1 | 2 | 3 | 4 | 5] += 1;
  }

  return {
    total: rows.length,
    visible,
    hidden,
    ratingAvg: visible === 0 ? null : sum / visible,
    rating1: buckets[1],
    rating2: buckets[2],
    rating3: buckets[3],
    rating4: buckets[4],
    rating5: buckets[5],
  };
}

/**
 * Renders an aggregate as a 0..5 string with one decimal, or `"—"` when
 * there are no visible reviews. Used in the profile header.
 */
export function formatRatingDisplay(agg: ReviewAggregate): string {
  if (agg.ratingAvg === null) return "—";
  // Round to one decimal. Don't display "5.0" as "5.00".
  return agg.ratingAvg.toFixed(1);
}