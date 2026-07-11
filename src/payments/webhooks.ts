/**
 * Webhook handling for Stripe events (YIL-9).
 *
 * Stripe sends events to `POST /api/webhooks/stripe` with a
 * `Stripe-Signature` header. We:
 *
 *   1. Read the **raw** request body (do NOT parse JSON — Stripe signs the
 *      raw bytes). Next's `Request.text()` gives us that.
 *   2. `stripe.webhooks.constructEvent(rawBody, sigHeader, secret)` to
 *      verify the signature; throws `StripeSignatureVerificationError`
 *      if invalid (we respond 400 with no body details).
 *   3. Dedupe on `event.id`. If we've already applied this event in the
 *      last 24h, return 200 immediately (Stripe expects 2xx on replays).
 *   4. Dispatch to a per-event-type handler that mutates the local
 *      payment_intents row + the parent orders row.
 *
 * Out-of-order or unexpected events are logged but **do not error** —
 * Stripe will retry on 5xx, and we don't want to amplify retries when
 * the issue is "wrong transition" (the next event in the sequence will
 * fix it).
 */

import type Stripe from "stripe";
import { getStripeClient, getStripeWebhookSecret } from "./stripe";
import { applyTransition, IllegalPaymentTransitionError } from "./state";
import type {
  PaymentIntentRecord,
  PaymentIntentState,
  StripeEventType,
} from "./types";

export interface WebhookRowStore {
  /**
   * Returns true if this event was already processed. The store must
   * also atomically record `event.id` so a concurrent webhook for the
   * same event doesn't double-apply.
   */
  hasSeenEvent(eventId: string): Promise<boolean>;
  recordEventSeen(eventId: string): Promise<void>;

  findByStripePaymentIntentId(
    stripePaymentIntentId: string
  ): Promise<PaymentIntentRecord | null>;

  /** Persist a transition. Returns the updated row. */
  applyTransition(
    record: PaymentIntentRecord,
    next: PaymentIntentState,
    refundedAmountCents?: number
  ): Promise<PaymentIntentRecord>;

  /** Mark the parent order as `paid` (or `disputed` / `cancelled`). */
  markOrderState(
    orderId: string,
    orderState: "paid" | "disputed" | "cancelled"
  ): Promise<void>;
}

export interface WebhookOutcome {
  status: "applied" | "duplicate" | "ignored" | "no_op";
  eventId: string;
  eventType: string;
  detail?: string;
}

/** Errors that should produce a 400 (do not retry). */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/** Verify the Stripe signature and return the parsed event. */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string = getStripeWebhookSecret()
): Stripe.Event {
  const stripe = getStripeClient();
  try {
    return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WebhookSignatureError(`Stripe signature verification failed: ${msg}`);
  }
}

/**
 * Decide which local PaymentIntentState a Stripe event implies.
 * Returns `null` when the event should be a no-op (e.g. duplicate of a
 * state we already hold).
 */
function stateFor(event: Stripe.Event): PaymentIntentState | null {
  switch (event.type) {
    case "payment_intent.succeeded":
      return "captured";
    case "payment_intent.payment_failed":
      return "failed";
    case "payment_intent.canceled":
      return "canceled";
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      // If the charge has been fully refunded, mark refunded; otherwise
      // partially_refunded. amount_refunded === amount captures the case
      // where Stripe auto-completes a refund that took our amount.
      return charge.amount_refunded === charge.amount
        ? "refunded"
        : "partially_refunded";
    }
    case "charge.dispute.created":
      return "disputed";
    default:
      return null;
  }
}

/** Map a webhook event onto the orders.state transition we want to make. */
function orderStateFor(event: Stripe.Event): "paid" | "disputed" | "cancelled" | null {
  switch (event.type) {
    case "payment_intent.succeeded":
      return "paid";
    case "charge.dispute.created":
      return "disputed";
    case "payment_intent.canceled":
      return "cancelled";
    default:
      return null;
  }
}

const HANDLED_EVENT_TYPES: ReadonlyArray<StripeEventType> = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.dispute.created",
];

export function isHandledEventType(t: string): t is StripeEventType {
  return (HANDLED_EVENT_TYPES as ReadonlyArray<string>).includes(t);
}

/**
 * Process one verified Stripe event end-to-end. Caller passes the raw
 * body and signature header — we verify, dedupe, dispatch, and return a
 * human-readable outcome.
 */
export async function handleWebhook(
  rawBody: string,
  signatureHeader: string,
  store: WebhookRowStore
): Promise<WebhookOutcome> {
  const event = verifyWebhook(rawBody, signatureHeader);

  if (await store.hasSeenEvent(event.id)) {
    return { status: "duplicate", eventId: event.id, eventType: event.type };
  }

  // Record the event id FIRST so concurrent webhooks for the same event
  // bail out before they touch the local row. We do this even for
  // unhandled types so replays don't keep re-running the type check.
  await store.recordEventSeen(event.id);

  if (!isHandledEventType(event.type)) {
    return {
      status: "ignored",
      eventId: event.id,
      eventType: event.type,
      detail: "event type not in HANDLED_EVENT_TYPES",
    };
  }

  const target = stateFor(event);
  if (target === null) {
    return {
      status: "ignored",
      eventId: event.id,
      eventType: event.type,
      detail: "no local state mapping",
    };
  }

  // Find the local row. For payment_intent.* events, the PI id is on
  // event.data.object.id. For charge.* events we look it up via the
  // charge's payment_intent field.
  const stripePaymentIntentId = extractStripePaymentIntentId(event);
  if (!stripePaymentIntentId) {
    return {
      status: "ignored",
      eventId: event.id,
      eventType: event.type,
      detail: "event has no payment_intent id",
    };
  }

  const record = await store.findByStripePaymentIntentId(stripePaymentIntentId);
  if (!record) {
    return {
      status: "ignored",
      eventId: event.id,
      eventType: event.type,
      detail: `no local row for stripe pi ${stripePaymentIntentId}`,
    };
  }

  // For charge.refunded, compute the new refunded amount from the charge
  // payload so the local row reflects what Stripe holds.
  let refundedAmountCents = record.refundedAmountCents;
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    refundedAmountCents = charge.amount_refunded;
  }

  try {
    const next = applyTransition(record, target);
    await store.applyTransition(record, target, refundedAmountCents);
    const orderTarget = orderStateFor(event);
    if (orderTarget) {
      await store.markOrderState(record.orderId, orderTarget);
    }
    return {
      status: "applied",
      eventId: event.id,
      eventType: event.type,
      detail: `${record.state} -> ${target}`,
    };
  } catch (err) {
    if (err instanceof IllegalPaymentTransitionError) {
      // Out-of-order event — log and accept. Stripe will not retry a 2xx
      // response and the next event in the sequence will reconcile.
      return {
        status: "no_op",
        eventId: event.id,
        eventType: event.type,
        detail: err.message,
      };
    }
    throw err;
  }
}

function extractStripePaymentIntentId(event: Stripe.Event): string | null {
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
      return (event.data.object as Stripe.PaymentIntent).id;
    case "charge.refunded":
    case "charge.dispute.created": {
      const obj = event.data.object as Stripe.Charge & {
        payment_intent?: string | null;
      };
      return typeof obj.payment_intent === "string" ? obj.payment_intent : null;
    }
    default:
      return null;
  }
}