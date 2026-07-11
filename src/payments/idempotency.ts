/**
 * Idempotency helpers for Stripe payments (YIL-9).
 *
 * Two surfaces:
 *
 * 1. `stripeIdempotencyKey(scope, id)` — derive the Stripe `Idempotency-Key`
 *    value we send on every Stripe API call. Stripe replays the cached
 *    response when the same key + body is sent within 24h, so an idempotent
 *    key tied to a stable domain id is enough to make retries safe.
 *
 * 2. `makeWebhookEventId()` — synthetic idempotency for inbound webhook
 *    events, derived from Stripe's `event.id` (evt_…). Stored in the
 *    `stripe_events_seen` table so we never apply the same event twice.
 *
 * Both helpers are pure — no I/O, no env access — so they can be unit
 * tested in isolation.
 */

const PREFIX = {
  intent: "pi-create",
  refund: "re-create",
} as const;

export type StripeIdempotencyScope = keyof typeof PREFIX;

/**
 * Build an idempotency key for a Stripe API call.
 *
 * Format: `<prefix>:<domain-id>`. The prefix lets us switch scopes later
 * (e.g. when we add Connect transfers) without colliding with prior
 * cached responses. Stripe accepts any string ≤255 chars.
 *
 * The domain id is whatever stable identifier makes the operation unique:
 * - `pi-create:<payment_intent_id>` — one PI per local record
 * - `re-create:<refund_record_id>` — one Refund per local record
 */
export function stripeIdempotencyKey(
  scope: StripeIdempotencyScope,
  domainId: string
): string {
  if (!domainId || domainId.length === 0) {
    throw new Error("domainId is required for idempotency key");
  }
  return `${PREFIX[scope]}:${domainId}`;
}

/** True iff the two webhook events are the same logical event. */
export function isSameWebhookEvent(a: string, b: string): boolean {
  return a === b && a.startsWith("evt_");
}

/**
 * Window we keep dedupe rows for. Stripe replays webhook events for up to
 * 30 days, but practically we only need 24h to ride out a deploy +
 * queue drain. Rows older than this can be pruned by a cron job.
 */
export const STRIPE_EVENT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Has the dedupe window elapsed since the event was first seen? */
export function isDedupeWindowExpired(receivedAt: Date, now: Date): boolean {
  return now.getTime() - receivedAt.getTime() > STRIPE_EVENT_DEDUPE_WINDOW_MS;
}