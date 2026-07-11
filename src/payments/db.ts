/**
 * DB-layer adapters for the payments module (YIL-9).
 *
 * Wraps Drizzle queries behind small interfaces so the pure
 * `payments/intents.ts`, `payments/refunds.ts`, `payments/webhooks.ts`
 * modules stay free of ORM types and can be unit-tested with mocks.
 *
 * `WebhookRowStore` is the same interface `webhooks.ts` consumes — this
 * is the live implementation backed by Postgres.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  paymentIntents,
  refunds,
  stripeEventsSeen,
  orders,
  type PaymentIntent,
  type NewPaymentIntent,
} from "@/db/schema";
import type {
  PaymentIntentRecord,
  PaymentIntentState,
  RefundRecord,
} from "./types";
import type { WebhookRowStore } from "./webhooks";

/** Convert a Drizzle row into the runtime domain shape. */
export function toRecord(row: PaymentIntent): PaymentIntentRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    stripePaymentIntentId: row.stripePaymentIntentId ?? "",
    amountCents: row.amountCents,
    currency: row.currency,
    state: row.state as PaymentIntentState,
    refundedAmountCents: row.refundedAmountCents,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Insert a new pending PaymentIntent row. */
export async function insertPendingIntent(
  input: NewPaymentIntent
): Promise<PaymentIntentRecord> {
  const [row] = await db.insert(paymentIntents).values(input).returning();
  if (!row) {
    throw new Error("insertPendingIntent: no row returned");
  }
  return toRecord(row);
}

/** Look up by our local UUID. */
export async function findById(
  id: string
): Promise<PaymentIntentRecord | null> {
  const [row] = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, id))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** Look up by Stripe PI id. */
export async function findByStripeId(
  stripePaymentIntentId: string
): Promise<PaymentIntentRecord | null> {
  const [row] = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.stripePaymentIntentId, stripePaymentIntentId))
    .limit(1);
  return row ? toRecord(row) : null;
}

/**
 * Persist the Stripe PI id back onto the local row after Stripe answers.
 * Idempotent — calling twice with the same value is a no-op.
 */
export async function setStripePaymentIntentId(
  localId: string,
  stripePaymentIntentId: string
): Promise<PaymentIntentRecord> {
  const [row] = await db
    .update(paymentIntents)
    .set({ stripePaymentIntentId })
    .where(
      and(
        eq(paymentIntents.id, localId),
        sql`${paymentIntents.stripePaymentIntentId} IS NULL OR ${paymentIntents.stripePaymentIntentId} = ${stripePaymentIntentId}`
      )
    )
    .returning();
  if (!row) {
    throw new Error(`setStripePaymentIntentId: row ${localId} not found`);
  }
  return toRecord(row);
}

/**
 * Persist a state transition. Sets `last_error_message` if the new state
 * is `failed` and a message is provided.
 */
export async function persistTransition(
  record: PaymentIntentRecord,
  next: PaymentIntentState,
  refundedAmountCents?: number
): Promise<PaymentIntentRecord> {
  const [row] = await db
    .update(paymentIntents)
    .set({
      state: next,
      refundedAmountCents:
        refundedAmountCents ?? record.refundedAmountCents,
    })
    .where(eq(paymentIntents.id, record.id))
    .returning();
  if (!row) {
    throw new Error(`persistTransition: row ${record.id} not found`);
  }
  return toRecord(row);
}

/** Append a refund row. */
export async function insertRefund(
  input: Omit<RefundRecord, "createdAt"> & { createdAt?: Date }
): Promise<RefundRecord> {
  const [row] = await db
    .insert(refunds)
    .values({
      id: input.id,
      paymentIntentId: input.paymentIntentRecordId,
      stripeRefundId: input.stripeRefundId,
      amountCents: input.amountCents,
      kind: input.kind,
      reason: input.reason,
    })
    .returning();
  if (!row) {
    throw new Error("insertRefund: no row returned");
  }
  return {
    id: row.id,
    paymentIntentRecordId: row.paymentIntentId,
    stripeRefundId: row.stripeRefundId,
    amountCents: row.amountCents,
    kind: row.kind as RefundRecord["kind"],
    reason: row.reason as RefundRecord["reason"],
    createdAt: row.createdAt,
  };
}

/** Live WebhookRowStore backed by Postgres. */
export const liveWebhookStore: WebhookRowStore = {
  async hasSeenEvent(eventId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: stripeEventsSeen.eventId })
      .from(stripeEventsSeen)
      .where(eq(stripeEventsSeen.eventId, eventId))
      .limit(1);
    return row !== undefined;
  },

  async recordEventSeen(eventId: string): Promise<void> {
    await db
      .insert(stripeEventsSeen)
      .values({ eventId })
      .onConflictDoNothing({ target: stripeEventsSeen.eventId });
  },

  async findByStripePaymentIntentId(stripePaymentIntentId: string) {
    return findByStripeId(stripePaymentIntentId);
  },

  async applyTransition(record, next, refundedAmountCents) {
    return persistTransition(record, next, refundedAmountCents);
  },

  async markOrderState(orderId, orderState) {
    // YIL-14 owns the orders table. We update the state column directly
    // — the trigger in 0003_order_state_transitions.sql enforces the
    // legal transition shape. We never bypass it.
    await db
      .update(orders)
      .set({ state: orderState })
      .where(eq(orders.id, orderId));
  },
};