import { describe, it, expect } from "vitest";
import {
  canTransition,
  nextStates,
  isReviewable,
  checkReviewEligibility,
  isValidRating,
  normalizeReviewSubmission,
  isModerationAction,
  shouldAutoHide,
  AUTO_HIDE_FLAG_THRESHOLD,
  type OrderState,
  type ReviewRole,
} from "./state";

describe("canTransition", () => {
  it("allows the happy path", () => {
    expect(canTransition("initiated", "paid")).toBe(true);
    expect(canTransition("paid", "fulfilled")).toBe(true);
    expect(canTransition("fulfilled", "completed")).toBe(true);
  });

  it("allows dispute from paid and fulfilled", () => {
    expect(canTransition("paid", "disputed")).toBe(true);
    expect(canTransition("fulfilled", "disputed")).toBe(true);
  });

  it("allows cancellation from initiated and paid only", () => {
    expect(canTransition("initiated", "cancelled")).toBe(true);
    expect(canTransition("paid", "cancelled")).toBe(true);
    expect(canTransition("fulfilled", "cancelled")).toBe(false);
    expect(canTransition("completed", "cancelled")).toBe(false);
  });

  it("forbids skipping ahead", () => {
    expect(canTransition("initiated", "fulfilled")).toBe(false);
    expect(canTransition("initiated", "completed")).toBe(false);
    expect(canTransition("paid", "completed")).toBe(false);
  });

  it("forbids going backwards", () => {
    expect(canTransition("paid", "initiated")).toBe(false);
    expect(canTransition("completed", "fulfilled")).toBe(false);
  });

  it("treats cancelled as the only true terminal state", () => {
    // Only `cancelled` has no outgoing edges. `completed` and `disputed`
    // both have an edge back to `disputed` for the post-fulfilment
    // dispute window — see src/orders/state-machine.ts.
    expect(nextStates("cancelled")).toEqual([]);
  });
});

describe("isReviewable", () => {
  it("is true only for completed", () => {
    expect(isReviewable("completed")).toBe(true);
  });
  it.each<OrderState>([
    "initiated",
    "paid",
    "fulfilled",
    "disputed",
    "cancelled",
  ])("is false for %s", (s) => {
    expect(isReviewable(s)).toBe(false);
  });
});

describe("checkReviewEligibility", () => {
  const completedOrder = {
    buyerId: "buyer-1",
    sellerId: "seller-1",
    state: "completed" as OrderState,
  };

  it("lets the buyer review the seller with role=buyer", () => {
    const result = checkReviewEligibility(completedOrder, "buyer-1", "buyer");
    expect(result).toEqual({ ok: true, revieweeId: "seller-1" });
  });

  it("lets the seller review the buyer with role=seller", () => {
    const result = checkReviewEligibility(completedOrder, "seller-1", "seller");
    expect(result).toEqual({ ok: true, revieweeId: "buyer-1" });
  });

  it("blocks a non-party", () => {
    const result = checkReviewEligibility(completedOrder, "rando", "buyer");
    expect(result).toEqual({ ok: false, reason: "not_a_party" });
  });

  it("blocks the buyer from reviewing themselves with role=seller", () => {
    const result = checkReviewEligibility(completedOrder, "buyer-1", "seller");
    expect(result).toEqual({ ok: false, reason: "role_mismatch" });
  });

  it("blocks the seller from reviewing themselves with role=buyer", () => {
    const result = checkReviewEligibility(completedOrder, "seller-1", "buyer");
    expect(result).toEqual({ ok: false, reason: "role_mismatch" });
  });

  it.each<OrderState>([
    "initiated",
    "paid",
    "fulfilled",
    "disputed",
    "cancelled",
  ])("blocks reviews on %s orders", (s) => {
    const result = checkReviewEligibility(
      { ...completedOrder, state: s },
      "buyer-1",
      "buyer"
    );
    expect(result).toEqual({ ok: false, reason: "wrong_state" });
  });
});

describe("isValidRating", () => {
  it("accepts 1..5 integers", () => {
    for (const v of [1, 2, 3, 4, 5]) expect(isValidRating(v)).toBe(true);
  });
  it("rejects 0, 6, floats, NaN, non-numbers", () => {
    for (const v of [0, 6, -1, 1.5, NaN, Infinity, "3", null, undefined]) {
      expect(isValidRating(v)).toBe(false);
    }
  });
});

describe("normalizeReviewSubmission", () => {
  it("trims body and keeps a valid rating", () => {
    const result = normalizeReviewSubmission({ rating: 5, body: "  great! " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toEqual({ rating: 5, body: "great!" });
    }
  });
  it("defaults body to empty string", () => {
    const result = normalizeReviewSubmission({ rating: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized.body).toBe("");
  });
  it("rejects oversized bodies", () => {
    const big = "x".repeat(2001);
    const result = normalizeReviewSubmission({ rating: 3, body: big });
    expect(result).toEqual({ ok: false, reason: "body_too_long" });
  });
  it("rejects invalid ratings", () => {
    const result = normalizeReviewSubmission({ rating: 7 });
    expect(result).toEqual({ ok: false, reason: "invalid_rating" });
  });
});

describe("isModerationAction", () => {
  it.each<[unknown, boolean]>([
    ["hide", true],
    ["restore", true],
    ["dismiss", true],
    ["delete", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("isModerationAction(%p) === %p", (input, expected) => {
    expect(isModerationAction(input)).toBe(expected);
  });
});

describe("shouldAutoHide", () => {
  it(`hides at >= ${AUTO_HIDE_FLAG_THRESHOLD} flags`, () => {
    expect(shouldAutoHide(AUTO_HIDE_FLAG_THRESHOLD - 1)).toBe(false);
    expect(shouldAutoHide(AUTO_HIDE_FLAG_THRESHOLD)).toBe(true);
    expect(shouldAutoHide(AUTO_HIDE_FLAG_THRESHOLD + 5)).toBe(true);
  });
});

describe("ReviewRole", () => {
  // Type-level sanity: the only valid roles are "buyer" and "seller".
  it("typecheck parity", () => {
    const a: ReviewRole = "buyer";
    const b: ReviewRole = "seller";
    expect([a, b].sort()).toEqual(["buyer", "seller"]);
  });
});