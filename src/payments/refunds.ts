/**
 * Refund path (YIL-9).
 *
 * We support full + partial refunds. Stripe's API uses `Refund.create`
 * with `payment_intent` (preferred over `charge` for PI-first flows).
 *
 * We pass:
 *   - `payment_intent` — the source PI id
 *   - `amount` (optional) — when omitted, Stripe refunds the full unrefunded
 *     amount. We pass it explicitly for partials.
 *   - `reason` — one of `duplicate | fraudulent | requested_by_customer`.
 *     `fraudulent` triggers Stripe Radar extra evidence requirements; we
 *     do NOT allow sellers to issue `fraudulent` (it would imply they
 *     shipped and the buyer's bank should claw back the seller).
 *   - `idempotency_key` — `re-create:<refund_record_id>` so retries are safe.
 *
 * The state machine in `state.ts` validates the resulting refund won't
 * exceed captured funds.
 */

import { getStripeClient } from "./stripe";
import { stripeIdempotencyKey } from "./idempotency";
import { computeRefundTotals } from "./state";
import type { PaymentIntentRecord, RefundRecord } from "./types";

export type RefundReason = "duplicate" | "fraudulent" | "requested_by_customer";

/**
 * Refund reasons sellers/admins are allowed to set. `fraudulent` is
 * restricted to admin-only flows — sellers cannot mark a buyer's payment
 * fraudulent (the buyer's bank would reverse the seller's payout).
 */
export const SELLER_ALLOWED_REFUND_REASONS: ReadonlyArray<RefundReason> = [
  "duplicate",
  "requested_by_customer",
];

export const ADMIN_ALLOWED_REFUND_REASONS: ReadonlyArray<RefundReason> = [
  "duplicate",
  "fraudulent",
  "requested_by_customer",
];

export class RefundNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundNotAllowedError";
  }
}

export interface CreateRefundInput {
  paymentIntentRecord: PaymentIntentRecord;
  refundRecordId: string;
  /** Optional — when undefined, refunds the remaining unrefunded amount. */
  amountCents?: number;
  reason: RefundReason;
  /** Who is initiating — used to enforce the reason allowlist above. */
  initiator: "buyer" | "seller" | "admin" | "system";
}

export interface CreateRefundResult {
  refund: RefundRecord;
  newPaymentIntentState: PaymentIntentRecord["state"];
  newRefundedAmountCents: number;
}

/**
 * Issue a refund via the Stripe API and compute the resulting local state.
 *
 * Pure-ish: takes the current local record, makes one Stripe API call,
 * returns the new shape. Persistence is the caller's job (`db.ts`).
 */
export async function createRefund(
  input: CreateRefundInput
): Promise<CreateRefundResult> {
  const allowedReasons =
    input.initiator === "admin" || input.initiator === "system"
      ? ADMIN_ALLOWED_REFUND_REASONS
      : SELLER_ALLOWED_REFUND_REASONS;

  if (!allowedReasons.includes(input.reason)) {
    throw new RefundNotAllowedError(
      `Refund reason '${input.reason}' is not allowed for initiator '${input.initiator}'`
    );
  }

  const amount =
    input.amountCents ??
    input.paymentIntentRecord.amountCents -
      input.paymentIntentRecord.refundedAmountCents;

  const totals = computeRefundTotals(input.paymentIntentRecord, amount);
  if (totals.kind === "full" && input.amountCents !== undefined && input.amountCents <= 0) {
    throw new RefundNotAllowedError("Full refund requires positive amount");
  }

  const stripe = getStripeClient();
  const idempotencyKey = stripeIdempotencyKey("refund", input.refundRecordId);

  const stripeRefund = await stripe.refunds.create(
    {
      payment_intent: input.paymentIntentRecord.stripePaymentIntentId,
      amount: amount,
      reason: input.reason,
      metadata: {
        payment_intent_record_id: input.paymentIntentRecord.id,
        order_id: input.paymentIntentRecord.orderId,
        initiator: input.initiator,
      },
    },
    { idempotencyKey }
  );

  const refundRecord: RefundRecord = {
    id: input.refundRecordId,
    paymentIntentRecordId: input.paymentIntentRecord.id,
    stripeRefundId: stripeRefund.id,
    amountCents: amount,
    kind: totals.kind,
    reason: input.reason,
    createdAt: new Date(),
  };

  return {
    refund: refundRecord,
    newPaymentIntentState: totals.kind === "full" ? "refunded" : "partially_refunded",
    newRefundedAmountCents: totals.refundedAmountCents,
  };
}