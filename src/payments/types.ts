/**
 * Domain types for Stripe payments (YIL-9).
 *
 * The `PaymentIntentRecord` is the local shadow of a Stripe PaymentIntent.
 * It is the source of truth for our app — Stripe is the upstream source of
 * truth for money movement, but the DB row is what the API surface reads
 * and what the webhook handler mutates.
 *
 * Keep this module free of Drizzle / Next / network so it can be unit-tested
 * without booting Postgres or the Stripe SDK. The DB row ↔ type mappers
 * live in `payments/db.ts`.
 */

/** Lifecycle of a local PaymentIntent record. */
export const PAYMENT_INTENT_STATES = [
  /** Created locally + sent to Stripe. Awaiting confirmation. */
  "pending",
  /** Stripe confirmed the payment method (card auth succeeded). */
  "authorized",
  /** Funds captured. Order is paid. */
  "captured",
  /** Stripe rejected the payment. Order stays unfulfilled. */
  "failed",
  /** Buyer/seller/system cancelled before capture. */
  "canceled",
  /** Fully refunded after capture. */
  "refunded",
  /** Partially refunded after capture (still has net captured funds). */
  "partially_refunded",
  /** Card network dispute opened. */
  "disputed",
] as const;

export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];

/**
 * A record of a Stripe PaymentIntent that we maintain locally.
 *
 * `stripePaymentIntentId` is `pi_…`. We do not collapse it with our own
 * UUID — keeping both makes Stripe lookups O(1) and survives Stripe-side
 * id reissues (none today, but the API allows them in disputes).
 */
export interface PaymentIntentRecord {
  id: string;
  orderId: string;
  stripePaymentIntentId: string;
  amountCents: number;
  currency: string; // 3-letter lowercase, e.g. "usd"
  state: PaymentIntentState;
  refundedAmountCents: number;
  /** Set when the buyer or seller most recently initiated an action. */
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A row we keep to remember we've already processed a webhook event. */
export interface StripeEventSeenRecord {
  eventId: string;
  receivedAt: Date;
}

/** A refund we issued via the Stripe Refunds API. */
export interface RefundRecord {
  id: string;
  paymentIntentRecordId: string;
  stripeRefundId: string; // re_…
  amountCents: number;
  /** `full` when amountCents == paymentIntent amount; otherwise `partial`. */
  kind: "full" | "partial";
  reason: "duplicate" | "fraudulent" | "requested_by_customer" | null;
  createdAt: Date;
}

/** The subset of Stripe webhook events we care about. */
export type StripeEventType =
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed"
  | "payment_intent.canceled"
  | "charge.refunded"
  | "charge.dispute.created";

/** Public error shape returned to API callers. */
export interface PaymentError {
  code:
    | "order_not_found"
    | "order_not_payable"
    | "amount_mismatch"
    | "currency_mismatch"
    | "stripe_error"
    | "webhook_signature_invalid"
    | "duplicate_event"
    | "unknown_event_type"
    | "internal_error";
  message: string;
}

/** Money moved through Stripe; Stripe returns integers in minor units. */
export interface Money {
  amountCents: number;
  currency: string;
}