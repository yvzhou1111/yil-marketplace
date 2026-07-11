/**
 * Pure state-machine logic for local PaymentIntentRecord rows.
 *
 * Mirrors the design of `src/reviews/state.ts`:
 *   - Pure functions, no Drizzle / Next / Stripe imports
 *   - Illegal transitions throw `IllegalPaymentTransitionError` so the
 *     webhook handler can decide whether to surface the failure (some
 *     Stripe events arrive out of order; a thrown transition becomes a
 *     no-op + log instead of a 500).
 *
 * State diagram:
 *
 *      pending ──► authorized ──► captured ──► refunded (terminal)
 *         │            │             │    ╲
 *         │            │             │     ╲► partially_refunded (terminal-ish;
 *         │            │             │        can still receive a charge.refunded
 *         │            │             │        that pushes it to refunded)
 *         │            │             ╲► disputed (terminal-ish; ops resolves)
 *         ▼            ▼
 *      failed       failed
 *      canceled     canceled
 *
 * Anything not in this table is forbidden.
 */

import {
  PAYMENT_INTENT_STATES,
  type PaymentIntentRecord,
  type PaymentIntentState,
} from "./types";

// Re-export so callers can `import { PAYMENT_INTENT_STATES, PaymentIntentState, PaymentIntentRecord } from "./state"`.
export { PAYMENT_INTENT_STATES };
export type { PaymentIntentState, PaymentIntentRecord };

const TRANSITIONS: Record<PaymentIntentState, ReadonlyArray<PaymentIntentState>> = {
  pending: ["authorized", "captured", "failed", "canceled"],
  authorized: ["captured", "failed", "canceled"],
  captured: [
    "refunded",
    "partially_refunded",
    "disputed",
  ],
  partially_refunded: ["refunded", "partially_refunded", "disputed"],
  // Terminal states — no transitions allowed except as documented.
  refunded: [],
  failed: [],
  canceled: [],
  disputed: ["refunded", "partially_refunded"], // ops can resolve with refund
};

export class IllegalPaymentTransitionError extends Error {
  constructor(
    public readonly from: PaymentIntentState,
    public readonly to: PaymentIntentState
  ) {
    super(`Illegal payment intent transition: ${from} -> ${to}`);
    this.name = "IllegalPaymentTransitionError";
  }
}

/** Pure: is this transition legal? */
export function canTransition(
  from: PaymentIntentState,
  to: PaymentIntentState
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Pure: which states can follow this one? Useful for API docs / UI. */
export function nextStates(
  from: PaymentIntentState
): ReadonlyArray<PaymentIntentState> {
  return TRANSITIONS[from];
}

/** Pure: assert a transition is legal or throw. */
export function assertTransition(
  from: PaymentIntentState,
  to: PaymentIntentState
): void {
  if (!canTransition(from, to)) {
    throw new IllegalPaymentTransitionError(from, to);
  }
}

/** Pure: is this state terminal (no further events expected)? */
export function isTerminal(state: PaymentIntentState): boolean {
  return TRANSITIONS[state].length === 0 && state !== "disputed";
    // disputed is operationally terminal but a refund can resolve it.
}

/**
 * Pure: apply a state transition to an in-memory record.
 *
 * Returns a new record; never mutates the input. Used by the webhook
 * handler before it persists to DB.
 */
export function applyTransition(
  record: PaymentIntentRecord,
  to: PaymentIntentState
): PaymentIntentRecord {
  assertTransition(record.state, to);
  return { ...record, state: to, updatedAt: new Date() };
}

/**
 * Pure: compute the new refunded amount after a refund of `amountCents`.
 * Throws if the refund would exceed the captured amount.
 */
export function computeRefundTotals(
  record: PaymentIntentRecord,
  additionalRefundCents: number
): { refundedAmountCents: number; kind: "partial" | "full" } {
  if (additionalRefundCents <= 0) {
    throw new Error("Refund amount must be positive");
  }
  if (record.state !== "captured" && record.state !== "partially_refunded") {
    throw new Error(
      `Refunds only allowed from captured or partially_refunded (was ${record.state})`
    );
  }
  const total = record.refundedAmountCents + additionalRefundCents;
  if (total > record.amountCents) {
    throw new Error(
      `Refund ${additionalRefundCents} would exceed captured ${record.amountCents} (already refunded ${record.refundedAmountCents})`
    );
  }
  return {
    refundedAmountCents: total,
    kind: total === record.amountCents ? "full" : "partial",
  };
}

/** Pure: list every known state. Useful for health endpoints and tests. */
export function listStates(): ReadonlyArray<PaymentIntentState> {
  return PAYMENT_INTENT_STATES;
}