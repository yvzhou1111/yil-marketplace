/**
 * POST /api/checkout/intent — create a PaymentIntent for an order.
 *
 * Body: { order_id: string, buyer_email?: string }
 *
 * Auth: buyer session (YIL-4 owns the actual auth; until then we accept
 * an `x-user-id` header for local exercising — same convention as
 * admin-console/src/lib/db.ts).
 *
 * Returns 200 with { transaction_id, stripe_payment_intent_id, client_secret }.
 *
 * Idempotent: retrying with the same order_id returns the same
 * PaymentIntent (we reuse the existing pending row if one exists).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { orders, users } from "@/db/schema";
import {
  createIntentForOrder,
  insertPendingIntent,
  findByStripeId,
  OrderNotPayableError,
  AmountMismatchError,
} from "@/payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  order_id: z.string().uuid(),
  buyer_email: z.string().email().optional(),
});

function requireUserId(req: Request): string | null {
  // YIL-4 owns real auth. Until then, accept x-user-id.
  return req.headers.get("x-user-id");
}

export async function POST(req: Request) {
  const userId = requireUserId(req);
  if (!userId) {
    return NextResponse.json(
      { code: "unauthenticated", message: "missing x-user-id" },
      { status: 401 }
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        code: "invalid_body",
        message: err instanceof z.ZodError ? err.message : "bad json",
      },
      { status: 400 }
    );
  }

  // Load the order + buyer.
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, body.order_id))
    .limit(1);
  if (!order) {
    return NextResponse.json(
      { code: "order_not_found", message: "no such order" },
      { status: 404 }
    );
  }
  if (order.buyerId !== userId) {
    return NextResponse.json(
      { code: "forbidden", message: "order is not yours" },
      { status: 403 }
    );
  }

  // Idempotent: if a pending PI already exists for this order, return it.
  const [existing] = await db
    .select()
    .from((await import("@/db/schema")).paymentIntents)
    .where(eq((await import("@/db/schema")).paymentIntents.orderId, body.order_id))
    .limit(1);
  if (existing && existing.stripePaymentIntentId && existing.state === "pending") {
    return NextResponse.json(
      {
        transaction_id: existing.id,
        stripe_payment_intent_id: existing.stripePaymentIntentId,
        client_secret: null, // unknown without a Stripe roundtrip; client should retry with new client_secret after re-create
      },
      { status: 200 }
    );
  }

  // Buyer email for Stripe receipt — best-effort, only if we can resolve it.
  let buyerEmail = body.buyer_email;
  if (!buyerEmail) {
    const [buyer] = await db
      .select({ handle: users.handle })
      .from(users)
      .where(eq(users.id, order.buyerId))
      .limit(1);
    if (buyer && buyer.handle.includes("@")) {
      buyerEmail = buyer.handle;
    }
  }

  // 1. Create the local row in 'pending' *before* talking to Stripe so we
  //    always have an idempotency key tied to a stable local id.
  const localRow = await insertPendingIntent({
    orderId: order.id,
    amountCents: order.amountMinor,
    currency: order.currency,
    state: "pending",
    refundedAmountCents: 0,
  });

  // 2. Call Stripe.
  try {
    const result = await createIntentForOrder({
      paymentIntentRecordId: localRow.id,
      order: {
        id: order.id,
        state: order.state,
        amountMinor: order.amountMinor,
        currency: order.currency,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
      },
      buyerEmail,
    });

    // 3. Persist the Stripe PI id onto our local row.
    const { setStripePaymentIntentId } = await import("@/payments/db");
    await setStripePaymentIntentId(localRow.id, result.stripePaymentIntentId);

    // Verify our local view (defensive — should never differ).
    const fresh = await findByStripeId(result.stripePaymentIntentId);
    if (!fresh) {
      throw new Error("local row vanished after Stripe create");
    }

    return NextResponse.json(
      {
        transaction_id: fresh.id,
        stripe_payment_intent_id: result.stripePaymentIntentId,
        client_secret: result.clientSecret,
      },
      { status: 200 }
    );
  } catch (err) {
    if (
      err instanceof OrderNotPayableError ||
      err instanceof AmountMismatchError
    ) {
      return NextResponse.json(
        { code: "order_not_payable", message: err.message },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { code: "stripe_error", message },
      { status: 502 }
    );
  }
}