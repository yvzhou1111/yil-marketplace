/**
 * GET /api/transactions/[id] — read a transaction's current state.
 *
 * YIL-4 owns real auth; until then accept `x-user-id` header. Only the
 * buyer or seller on the underlying order (or an admin) may read.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { orders } from "@/db/schema";
import { findById } from "@/payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: { id: string } }
) {
  const userId = req.headers.get("x-user-id");
  const userRole = req.headers.get("x-user-role") ?? "buyer";
  if (!userId) {
    return NextResponse.json(
      { code: "unauthenticated", message: "missing x-user-id" },
      { status: 401 }
    );
  }

  const intent = await findById(ctx.params.id);
  if (!intent) {
    return NextResponse.json(
      { code: "transaction_not_found", message: "no such transaction" },
      { status: 404 }
    );
  }

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, intent.orderId))
    .limit(1);
  if (!order) {
    return NextResponse.json(
      { code: "order_not_found", message: "transaction has no order" },
      { status: 500 }
    );
  }

  const isParty = order.buyerId === userId || order.sellerId === userId;
  if (!isParty && userRole !== "admin") {
    return NextResponse.json(
      { code: "forbidden", message: "not a party to this transaction" },
      { status: 403 }
    );
  }

  return NextResponse.json(
    {
      transaction_id: intent.id,
      order_id: intent.orderId,
      stripe_payment_intent_id: intent.stripePaymentIntentId,
      amount_cents: intent.amountCents,
      currency: intent.currency,
      state: intent.state,
      refunded_amount_cents: intent.refundedAmountCents,
      order_state: order.state,
      last_error_message: intent.lastErrorMessage,
      created_at: intent.createdAt.toISOString(),
      updated_at: intent.updatedAt.toISOString(),
    },
    { status: 200 }
  );
}