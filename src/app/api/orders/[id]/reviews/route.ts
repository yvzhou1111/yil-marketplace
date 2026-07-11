/**
 * POST /api/orders/[id]/reviews — submit a review for a completed order.
 * GET  /api/orders/[id]/reviews — list reviews for an order (both sides).
 */
import { NextResponse } from "next/server";
import { and, eq, asc, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { reviews } from "@/db/schema";
import { submitReview } from "@/reviews/service";
import {
  callerFromHeaders,
  requireUuid,
  unauthorizedResponse,
  errorResponse,
} from "@/reviews/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const submitSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().max(2000).optional(),
  role: z.enum(["buyer", "seller"]),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const caller = callerFromHeaders(req);
  if (!caller) return unauthorizedResponse();

  const orderId = requireUuid(params.id);
  if (!orderId) {
    return errorResponse(400, "bad_order_id");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json");
  }
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "invalid_body", {
      issues: parsed.error.issues,
    });
  }

  const result = await submitReview(db, {
    orderId,
    reviewerId: caller.userId,
    rating: parsed.data.rating,
    body: parsed.data.body,
    role: parsed.data.role,
  });

  if (!result.ok) {
    return errorResponse(result.status, result.code);
  }
  return NextResponse.json({ reviewId: result.reviewId }, { status: 201 });
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const orderId = requireUuid(params.id);
  if (!orderId) {
    return errorResponse(400, "bad_order_id");
  }

  // Public read: includes both buyer and seller reviews. Hidden reviews
  // are excluded — the API is not the place for moderators to debug.
  const rows = await db
    .select({
      id: reviews.id,
      role: reviews.role,
      rating: reviews.rating,
      body: reviews.body,
      reviewerId: reviews.reviewerId,
      revieweeId: reviews.revieweeId,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(and(eq(reviews.orderId, orderId), isNull(reviews.hiddenAt)))
    .orderBy(asc(reviews.createdAt));

  return NextResponse.json({ orderId, reviews: rows });
}