/**
 * Service-layer tests for review submission and moderation.
 *
 * These do NOT touch Postgres. We mock the Drizzle query builder enough to
 * exercise the service's control flow:
 *   - The eligibility gate
 *   - Unique-violation → already_reviewed / already_flagged
 *   - Auto-hide threshold trigger
 *   - Moderator no-ops on stale state
 *
 * Heavy integration tests against a real DB live under
 * tests/integration/reviews (out of scope for this issue).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock @/db/schema so service.ts's static imports resolve without
// requiring the full Drizzle runtime to be wired up.
vi.mock("@/db/schema", () => ({
  orders: { id: "id" },
  reviews: { id: "id" },
  reviewFlags: { id: "id" },
  reviewModerationActions: {},
}));

import {
  submitReview,
  flagReview,
  moderateReview,
  countOpenFlags,
} from "./service";
import {
  AUTO_HIDE_FLAG_THRESHOLD,
} from "./state";

interface FakeQuery<T> {
  findFirst: (opts: unknown) => Promise<T | undefined>;
}

/**
 * Build a fake Drizzle db handle with the methods our service uses.
 * Each test wires the data it needs.
 */
function makeDb(opts: {
  order?: unknown;
  review?: unknown;
  uniqueErrors?: Map<string, Error>;
}): any {
  const { order, review, uniqueErrors } = opts;
  const calls = { findFirstOrder: 0, findFirstReview: 0 };

  const errorFor = (constraint: string): Error => {
    const err = uniqueErrors?.get(constraint);
    if (!err) throw new Error(`unexpected constraint error: ${constraint}`);
    return err;
  };

  return {
    query: {
      orders: {
        findFirst: async () => {
          calls.findFirstOrder++;
          return order;
        },
      } satisfies FakeQuery<unknown>,
      reviews: {
        findFirst: async () => {
          calls.findFirstReview++;
          return review;
        },
      } satisfies FakeQuery<unknown>,
    },
    insert: (_table: unknown) => ({
      values: (v: any) => ({
        returning: async (cols: any) => {
          // Surface unique-violation on any unique constraint the caller used.
          const constraint =
            v.orderId && v.role
              ? "reviews_one_per_side_unique"
              : v.reviewId && v.reporterId
                ? "review_flags_one_per_reporter"
                : null;
          if (constraint && uniqueErrors?.has(constraint)) {
            throw errorFor(constraint);
          }
          return [{ [Object.keys(cols)[0]!]: "row-1" }];
        },
      }),
    }),
    update: (_table: unknown) => ({
      set: (_v: any) => ({
        where: async () => undefined,
      }),
    }),
    select: () => ({
      from: (_t: unknown) => ({
        where: async () => [{ count: 0 }],
      }),
    }),
    _calls: calls,
  };
}

const uniqueViolation = (constraint: string): Error => {
  const e = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  (e as any).code = "23505";
  return e;
};

const completedOrder = {
  id: "order-1",
  buyerId: "buyer-1",
  sellerId: "seller-1",
  state: "completed",
};

const visibleReview = {
  id: "review-1",
  reviewerId: "reviewer-1",
  revieweeId: "reviewee-1",
  rating: 1,
  body: "spam",
  hiddenAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitReview", () => {
  it("submits a buyer review of the seller", async () => {
    const db = makeDb({ order: completedOrder });
    const result = await submitReview(db, {
      orderId: "order-1",
      reviewerId: "buyer-1",
      rating: 5,
      body: "great",
      role: "buyer",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reviewId).toBe("row-1");
  });

  it("blocks on a non-completed order", async () => {
    const db = makeDb({
      order: { ...completedOrder, state: "paid" },
    });
    const result = await submitReview(db, {
      orderId: "order-1",
      reviewerId: "buyer-1",
      rating: 5,
      role: "buyer",
    });
    expect(result).toEqual({ ok: false, status: 409, code: "wrong_state" });
  });

  it("blocks a non-party", async () => {
    const db = makeDb({ order: completedOrder });
    const result = await submitReview(db, {
      orderId: "order-1",
      reviewerId: "rando",
      rating: 5,
      role: "buyer",
    });
    expect(result).toEqual({ ok: false, status: 403, code: "not_a_party" });
  });

  it("blocks a role mismatch", async () => {
    const db = makeDb({ order: completedOrder });
    const result = await submitReview(db, {
      orderId: "order-1",
      reviewerId: "buyer-1",
      rating: 5,
      role: "seller",
    });
    expect(result).toEqual({ ok: false, status: 403, code: "role_mismatch" });
  });

  it("surfaces unique-violation as already_reviewed", async () => {
    const db = makeDb({
      order: completedOrder,
      uniqueErrors: new Map([
        ["reviews_one_per_side_unique", uniqueViolation("reviews_one_per_side_unique")],
      ]),
    });
    const result = await submitReview(db, {
      orderId: "order-1",
      reviewerId: "buyer-1",
      rating: 5,
      role: "buyer",
    });
    expect(result).toEqual({ ok: false, status: 409, code: "already_reviewed" });
  });

  it("returns invalid_rating for a rating of 7", async () => {
    const db = makeDb({ order: completedOrder });
    const result = await submitReview(db, {
      orderId: "order-1",
      reviewerId: "buyer-1",
      rating: 7,
      role: "buyer",
    });
    expect(result).toEqual({ ok: false, status: 400, code: "invalid_rating" });
  });
});

describe("flagReview", () => {
  it("records a flag", async () => {
    const db = makeDb({ review: visibleReview });
    const result = await flagReview(db, {
      reviewId: "review-1",
      reporterId: "reporter-1",
      reason: "spam",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flagId).toBe("row-1");
      expect(result.autoHidden).toBe(false);
    }
  });

  it("blocks self-flag", async () => {
    const db = makeDb({
      review: { ...visibleReview, reviewerId: "self-id" },
    });
    const result = await flagReview(db, {
      reviewId: "review-1",
      reporterId: "self-id",
      reason: "spam",
    });
    expect(result).toEqual({ ok: false, status: 403, code: "self_flag" });
  });

  it("returns already_flagged on duplicate", async () => {
    const db = makeDb({
      review: visibleReview,
      uniqueErrors: new Map([
        [
          "review_flags_one_per_reporter",
          uniqueViolation("review_flags_one_per_reporter"),
        ],
      ]),
    });
    const result = await flagReview(db, {
      reviewId: "review-1",
      reporterId: "reporter-1",
      reason: "spam",
    });
    expect(result).toEqual({ ok: false, status: 409, code: "already_flagged" });
  });

  it("blocks flagging an already-hidden review", async () => {
    const db = makeDb({
      review: { ...visibleReview, hiddenAt: new Date() },
    });
    const result = await flagReview(db, {
      reviewId: "review-1",
      reporterId: "reporter-1",
      reason: "spam",
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      code: "cannot_flag_hidden",
    });
  });

  it(`auto-hides at ${AUTO_HIDE_FLAG_THRESHOLD} open flags`, async () => {
    // Build a db where the open-flag count read returns >= threshold so
    // the service flips the review to hidden.
    const calls: string[] = [];
    const db: any = {
      query: {
        reviews: {
          findFirst: async () => visibleReview,
        },
      },
      insert: (table: unknown) => ({
        values: (v: any) => ({
          returning: async (cols: any) => {
            calls.push(`insert:${Object.keys(cols)[0]}`);
            return [{ [Object.keys(cols)[0]!]: "row-1" }];
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (v: any) => ({
          where: async () => {
            calls.push(`update:${v.hiddenAt ? "hide" : "noop"}`);
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => [
            // Pretend we've already reached the threshold.
            { count: AUTO_HIDE_FLAG_THRESHOLD },
          ],
        }),
      }),
    };

    const result = await flagReview(db, {
      reviewId: "review-1",
      reporterId: "reporter-1",
      reason: "spam",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.autoHidden).toBe(true);
      expect(result.openFlagCount).toBe(AUTO_HIDE_FLAG_THRESHOLD);
    }
    // Hide path was exercised.
    expect(calls).toContain("update:hide");
  });
});

describe("moderateReview", () => {
  it("hides a visible review", async () => {
    const actions: string[] = [];
    const db: any = {
      query: {
        reviews: { findFirst: async () => visibleReview },
      },
      update: () => ({
        set: () => ({
          where: async () => {
            actions.push("update");
          },
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: "row-1" }],
        }),
      }),
    };
    const result = await moderateReview(db, {
      reviewId: "review-1",
      actorId: "admin-1",
      action: "hide",
      reason: "spam",
    });
    expect(result.ok).toBe(true);
    expect(actions).toContain("update");
  });

  it("returns no_op when hiding an already-hidden review", async () => {
    const db = makeDb({
      review: { ...visibleReview, hiddenAt: new Date() },
    });
    const result = await moderateReview(db, {
      reviewId: "review-1",
      actorId: "admin-1",
      action: "hide",
    });
    expect(result).toEqual({ ok: false, status: 409, code: "no_op" });
  });

  it("returns no_op when restoring a non-hidden review", async () => {
    const db = makeDb({ review: visibleReview });
    const result = await moderateReview(db, {
      reviewId: "review-1",
      actorId: "admin-1",
      action: "restore",
    });
    expect(result).toEqual({ ok: false, status: 409, code: "no_op" });
  });
});

describe("countOpenFlags", () => {
  it("returns a number even when the aggregate yields 0", async () => {
    const db = makeDb({});
    const n = await countOpenFlags(db, "review-1");
    expect(typeof n).toBe("number");
  });
});