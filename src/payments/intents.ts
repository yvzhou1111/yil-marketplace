/**
 * Payment-intent creation + lookup (YIL-9).
 *
 * The buyer hits `POST /api/checkout/intent` with an `order_id`. We:
 *   1. Load the order and confirm it's payable (`state = 'initiated'`).
 *   2. Confirm the amount/currency we are about to charge matches the
 *      order snapshot (catches client tampering + price-change races).
 *   3. Create a `payment_intents` row in `pending`.
 *   4. Call Stripe `paymentIntents.create` with our idempotency key.
 *   5. Return `{ client_secret, payment_intent_id }` so the browser can
 *      `stripe.confirmCardPayment(client_secret)`.
 *
 * Capture is automatic by default — Stripe `capture_method: 'automatic'`
 * captures funds when the card is confirmed. We use that for v1; switching
 * to manual capture is a one-line change once a seller-confirm step exists.
 */

import { getStripeClient } from "./stripe";
import { stripeIdempotencyKey } from "./idempotency";
import type { PaymentIntentRecord } from "./types";

export class OrderNotPayableError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly orderState: string
  ) {
    super(
      `Order ${orderId} is in state '${orderState}'; only 'initiated' orders are payable`
    );
    this.name = "OrderNotPayableError";
  }
}

export class AmountMismatchError extends Error {
  constructor(
    public readonly expected: number,
    public readonly got: number
  ) {
    super(
      `Amount mismatch: order expects ${expected} minor units, got ${got}`
    );
    this.name = "AmountMismatchError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly got: string
  ) {
    super(
      `Currency mismatch: order expects ${expected}, got ${got}`
    );
    this.name = "CurrencyMismatchError";
  }
}

export interface OrderSnapshot {
  id: string;
  state: string;
  amountMinor: number;
  currency: string;
  buyerId: string;
  sellerId: string;
}

export interface CreateIntentInput {
  paymentIntentRecordId: string;
  order: OrderSnapshot;
  buyerEmail?: string;
}

export interface CreateIntentResult {
  paymentIntentRecordId: string;
  stripePaymentIntentId: string;
  clientSecret: string;
}

/**
 * Create a Stripe PaymentIntent for an order. Idempotent on
 * `paymentIntentRecordId` — retrying with the same input within 24h
 * returns Stripe's cached response without creating a duplicate PI.
 */
export async function createIntentForOrder(
  input: CreateIntentInput
): Promise<CreateIntentResult> {
  if (input.order.state !== "initiated") {
    throw new OrderNotPayableError(input.order.id, input.order.state);
  }
  if (input.order.amountMinor <= 0) {
    throw new AmountMismatchError(input.order.amountMinor, 0);
  }

  const stripe = getStripeClient();
  const idempotencyKey = stripeIdempotencyKey(
    "intent",
    input.paymentIntentRecordId
  );

  const params: import("stripe").Stripe.PaymentIntentCreateParams = {
    amount: input.order.amountMinor,
    currency: input.order.currency.toLowerCase(),
    capture_method: "automatic",
    automatic_payment_methods: { enabled: true },
    metadata: {
      order_id: input.order.id,
      payment_intent_record_id: input.paymentIntentRecordId,
      buyer_id: input.order.buyerId,
      seller_id: input.order.sellerId,
    },
    description: `Marketplace order ${input.order.id}`,
  };
  if (input.buyerEmail) {
    params.receipt_email = input.buyerEmail;
  }

  // The Stripe SDK types `PaymentIntent.create` as overloaded — cast to a
  // function so we can pass the typed params explicitly.
  const stripeIntent = await (
    stripe.paymentIntents.create as (
      params: import("stripe").Stripe.PaymentIntentCreateParams,
      options: { idempotencyKey: string }
    ) => Promise<import("stripe").Stripe.PaymentIntent>
  )(params, { idempotencyKey });

  return {
    paymentIntentRecordId: input.paymentIntentRecordId,
    stripePaymentIntentId: stripeIntent.id,
    clientSecret: stripeIntent.client_secret ?? "",
  };
}

/**
 * Look up a PaymentIntent on Stripe. Used by the webhook handler when a
 * PI id arrives but we want to confirm the latest status before mutating
 * the local row. (Webhook payloads are usually enough; this is a fallback.)
 */
export async function retrievePaymentIntent(
  stripePaymentIntentId: string
): Promise<import("stripe").Stripe.PaymentIntent> {
  const stripe = getStripeClient();
  return stripe.paymentIntents.retrieve(stripePaymentIntentId);
}

/**
 * Build the local-row shape that `db.insert(paymentIntents)` will write,
 * before Stripe has answered. Stays here so `intents.ts` owns the full
 * create-time shape.
 */
export function newPendingRecord(
  input: CreateIntentInput,
  now: Date = new Date()
): Omit<PaymentIntentRecord, "stripePaymentIntentId"> & {
  stripePaymentIntentId: null;
} {
  return {
    id: input.paymentIntentRecordId,
    orderId: input.order.id,
    stripePaymentIntentId: null,
    amountCents: input.order.amountMinor,
    currency: input.order.currency.toLowerCase(),
    state: "pending",
    refundedAmountCents: 0,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}