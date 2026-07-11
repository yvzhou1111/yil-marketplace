/**
 * POST /api/refunds — issue a refund against a captured PaymentIntent.
 *
 * Body: {
 *   transaction_id: string,            // our local PaymentIntentRecord id
 *   amount_cents?: number,             // omit for full refund of remaining
 *   reason: 'duplicate' | 'fraudulent' | 'requested_by_customer'
 * }
 *
 * Auth: seller of the listing, or admin. YIL-4 owns real auth — for now
 * we accept `x-user-id` + `x-user-role` headers (same pattern as
 * admin-console). `fraudulent` reason is admin-only.
 *
 * Returns 200 with { refund_id, new_transaction_state }.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createRefund,
  RefundNotAllowedError,
  findById as findIntentById,
  insertRefund,
  persistTransition,
} from "@/payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  transaction_id: z.string().uuid(),
  amount_cents: z.number().int().positive().optional(),
  reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]),
});

export async function POST(req: Request) {
  // YIL-4 owns real auth; until then accept headers.
  const userId = req.headers.get("x-user-id");
  const userRole = req.headers.get("x-user-role") ?? "buyer";
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

  const intent = await findIntentById(body.transaction_id);
  if (!intent) {
    return NextResponse.json(
      { code: "transaction_not_found", message: "no such transaction" },
      { status: 404 }
    );
  }

  // Only admin or system can mark a payment fraudulent (fraudulent implies
  // a chargeback narrative that affects the seller). Sellers can only
  // issue duplicate / requested_by_customer refunds.
  const initiator =
    userRole === "admin"
      ? "admin"
      : userRole === "system"
        ? "system"
        : "seller";
  if (initiator === "seller" && body.reason === "fraudulent") {
    return NextResponse.json(
      {
        code: "refund_not_allowed",
        message: "only admins may issue fraudulent refunds",
      },
      { status: 403 }
    );
  }

  // Refund record id is generated here so callers can dedupe on it.
  const refundRecordId = crypto.randomUUID();

  try {
    const result = await createRefund({
      paymentIntentRecord: intent,
      refundRecordId,
      amountCents: body.amount_cents,
      reason: body.reason,
      initiator,
    });

    // Persist refund + transition.
    await insertRefund(result.refund);
    await persistTransition(
      intent,
      result.newPaymentIntentState,
      result.newRefundedAmountCents
    );

    return NextResponse.json(
      {
        refund_id: result.refund.id,
        new_transaction_state: result.newPaymentIntentState,
        refunded_amount_cents: result.newRefundedAmountCents,
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof RefundNotAllowedError) {
      return NextResponse.json(
        { code: "refund_not_allowed", message: err.message },
        { status: 403 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { code: "stripe_error", message },
      { status: 502 }
    );
  }
}
