/**
 * GET /api/admin/review-flags — list flagged reviews for the admin queue.
 *
 * Returns one row per flagged review, with the open-flag count and the
 * review itself. Hidden reviews are included so moderators can see the
 * auto-hidden ones and decide whether to restore or keep them down.
 */
import { NextResponse } from "next/server";
import { eq, sql, isNull, desc, and } from "drizzle-orm";
import { db } from "@/db/client";
import { reviews, reviewFlags } from "@/db/schema";
import {
  callerFromHeaders,
  unauthorizedResponse,
  forbiddenResponse,
} from "@/reviews/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const caller = callerFromHeaders(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.isAdmin) return forbiddenResponse("admin_only");

  const url = new URL(req.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : PAGE_SIZE,
    200
  );

  // Pull every review that has at least one OPEN flag, with the count.
  // Order by open-flag count desc so the worst offenders surface first.
  const rows = await db
    .select({
      reviewId: reviews.id,
      orderId: reviews.orderId,
      reviewerId: reviews.reviewerId,
      revieweeId: reviews.revieweeId,
      role: reviews.role,
      rating: reviews.rating,
      body: reviews.body,
      hiddenAt: reviews.hiddenAt,
      hiddenReason: reviews.hiddenReason,
      createdAt: reviews.createdAt,
      openFlags: sql<number>`count(${reviewFlags.id})::int`,
    })
    .from(reviews)
    .innerJoin(
      reviewFlags,
      and(
        eq(reviewFlags.reviewId, reviews.id),
        isNull(reviewFlags.resolvedAt)
      )
    )
    .groupBy(reviews.id)
    .orderBy(desc(sql`count(${reviewFlags.id})`), desc(reviews.createdAt))
    .limit(limit);

  return NextResponse.json({ items: rows, limit });
}