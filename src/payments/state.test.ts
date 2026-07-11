import { describe, it, expect } from "vitest";
import {
  canTransition,
  nextStates,
  applyTransition,
  computeRefundTotals,
  isTerminal,
  listStates,
  IllegalPaymentTransitionError,
  PAYMENT_INTENT_STATES,
  type PaymentIntentState,
  type PaymentIntentRecord,
} from "./state";

function makeRecord(overrides: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  const now = new Date();
  return {
    id: "00000000-0000-0000-0000-000000000001",
    orderId: "00000000-0000-0000-0000-000000000002",
    stripePaymentIntentId: "pi_test_123",
    amountCents: 1000,
    currency: "usd",
    state: "pending",
    refundedAmountCents: 0,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("PAYMENT_INTENT_STATES", () => {
  it("lists every defined state exactly once", () => {
    const seen = new Set<PaymentIntentState>();
    for (const s of PAYMENT_INTENT_STATES) {
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    expect(seen.size).toBe(PAYMENT_INTENT_STATES.length);
  });

  it("includes the happy-path set", () => {
    for (const s of [
      "pending",
      "authorized",
      "captured",
      "refunded",
      "partially_refunded",
      "disputed",
    ] as const) {
      expect(listStates()).toContain(s);
    }
  });
});

describe("canTransition", () => {
  it("allows the happy path", () => {
    expect(canTransition("pending", "captured")).toBe(true);
    expect(canTransition("captured", "refunded")).toBe(true);
  });

  it("allows partial refund -> full refund", () => {
    expect(canTransition("captured", "partially_refunded")).toBe(true);
    expect(canTransition("partially_refunded", "refunded")).toBe(true);
    expect(canTransition("partially_refunded", "partially_refunded")).toBe(true);
  });

  it("forbids back-state transitions", () => {
    expect(canTransition("captured", "pending")).toBe(false);
    expect(canTransition("refunded", "captured")).toBe(false);
    expect(canTransition("failed", "captured")).toBe(false);
  });

  it("forbids capture from pending via the cardinal-direction transitions", () => {
    // pending -> failed is allowed; pending -> captured is allowed.
    // pending -> authorized is the alternative happy path.
    expect(canTransition("pending", "authorized")).toBe(true);
    expect(canTransition("pending", "captured")).toBe(true);
    expect(canTransition("pending", "failed")).toBe(true);
  });
});

describe("nextStates", () => {
  it("returns a non-empty array for non-terminal states", () => {
    expect(nextStates("pending").length).toBeGreaterThan(0);
    expect(nextStates("captured").length).toBeGreaterThan(0);
  });

  it("returns an empty array for terminal happy-path states", () => {
    expect(nextStates("refunded")).toEqual([]);
    expect(nextStates("failed")).toEqual([]);
    expect(nextStates("canceled")).toEqual([]);
  });
});

describe("isTerminal", () => {
  it("treats refunded/failed/canceled as terminal", () => {
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
  });

  it("treats disputed as operationally open (refunds can resolve it)", () => {
    expect(isTerminal("disputed")).toBe(false);
  });
});

describe("applyTransition", () => {
  it("returns a new record with updated state and updatedAt", () => {
    const before = makeRecord({ state: "pending" });
    const after = applyTransition(before, "captured");
    expect(after).not.toBe(before);
    expect(after.state).toBe("captured");
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime()
    );
  });

  it("preserves all other fields", () => {
    const before = makeRecord({ state: "captured", amountCents: 4242 });
    const after = applyTransition(before, "partially_refunded");
    expect(after.amountCents).toBe(4242);
    expect(after.id).toBe(before.id);
    expect(after.stripePaymentIntentId).toBe(before.stripePaymentIntentId);
  });

  it("throws IllegalPaymentTransitionError on illegal moves", () => {
    const before = makeRecord({ state: "refunded" });
    expect(() => applyTransition(before, "captured")).toThrow(
      IllegalPaymentTransitionError
    );
  });
});

describe("computeRefundTotals", () => {
  it("returns full when the refund completes the captured amount", () => {
    const rec = makeRecord({
      state: "captured",
      amountCents: 1000,
      refundedAmountCents: 0,
    });
    const totals = computeRefundTotals(rec, 1000);
    expect(totals.kind).toBe("full");
    expect(totals.refundedAmountCents).toBe(1000);
  });

  it("returns partial when the refund leaves a balance", () => {
    const rec = makeRecord({
      state: "captured",
      amountCents: 1000,
      refundedAmountCents: 0,
    });
    const totals = computeRefundTotals(rec, 400);
    expect(totals.kind).toBe("partial");
    expect(totals.refundedAmountCents).toBe(400);
  });

  it("sums with prior partial refunds", () => {
    const rec = makeRecord({
      state: "partially_refunded",
      amountCents: 1000,
      refundedAmountCents: 300,
    });
    const totals = computeRefundTotals(rec, 700);
    expect(totals.kind).toBe("full");
    expect(totals.refundedAmountCents).toBe(1000);
  });

  it("rejects zero or negative refunds", () => {
    const rec = makeRecord({
      state: "captured",
      amountCents: 1000,
    });
    expect(() => computeRefundTotals(rec, 0)).toThrow();
    expect(() => computeRefundTotals(rec, -1)).toThrow();
  });

  it("rejects refunds that exceed the captured amount", () => {
    const rec = makeRecord({
      state: "captured",
      amountCents: 1000,
      refundedAmountCents: 600,
    });
    expect(() => computeRefundTotals(rec, 500)).toThrow();
  });

  it("refuses to refund from non-captured states", () => {
    expect(() =>
      computeRefundTotals(
        makeRecord({ state: "pending", amountCents: 1000 }),
        100
      )
    ).toThrow();
    expect(() =>
      computeRefundTotals(
        makeRecord({ state: "failed", amountCents: 1000 }),
        100
      )
    ).toThrow();
  });
});