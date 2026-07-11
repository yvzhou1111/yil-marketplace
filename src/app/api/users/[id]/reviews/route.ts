/**
 * GET /api/users/[id]/reviews — public reviews written about a user.
 *
 * Hidden reviews are excluded by design: a moderator-hidden review is not
 * the user's fault and should not leak through any public path.
 */
import { NextResponse } from "next/server";
import { and, eq, desc, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { reviews } from "@/db/schema";
import { aggregateReviews, formatRatingDisplay } from "@/reviews/aggregate";
import { requireUuid, errorResponse } from "@/reviews/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = requireUuid(params.id);
  if (!userId) return errorResponse(400, "bad_user_id");

  const rows = await db
    .select({
      id: reviews.id,
      orderId: reviews.orderId,
      role: reviews.role,
      rating: reviews.rating,
      body: reviews.body,
      reviewerId: reviews.reviewerId,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(and(eq(reviews.revieweeId, userId), isNull(reviews.hiddenAt)))
    .orderBy(desc(reviews.createdAt))
    .limit(100);

  const agg = aggregateReviews(
    rows.map((r) => ({ rating: r.rating, hiddenAt: null }))
  );

  return NextResponse.json({
    userId,
    reviews: rows,
    aggregate: {
      ...agg,
      ratingDisplay: formatRatingDisplay(agg),
    },
  });
}