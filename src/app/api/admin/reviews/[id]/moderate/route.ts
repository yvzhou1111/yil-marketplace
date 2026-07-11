/**
 * POST /api/admin/reviews/[id]/moderate — admin moderation action.
 *
 *   - `hide`    → soft-hide the review
 *   - `restore` → clear the hidden state
 *   - `dismiss` → resolve all open flags without hiding
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { moderateReview } from "@/reviews/service";
import {
  callerFromHeaders,
  requireUuid,
  unauthorizedResponse,
  forbiddenResponse,
  errorResponse,
} from "@/reviews/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const moderateSchema = z.object({
  action: z.enum(["hide", "restore", "dismiss"]),
  reason: z.string().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const caller = callerFromHeaders(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.isAdmin) return forbiddenResponse("admin_only");

  const reviewId = requireUuid(params.id);
  if (!reviewId) return errorResponse(400, "bad_review_id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json");
  }
  const parsed = moderateSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "invalid_body", {
      issues: parsed.error.issues,
    });
  }

  const result = await moderateReview(db, {
    reviewId,
    actorId: caller.userId,
    action: parsed.data.action,
    reason: parsed.data.reason,
  });

  if (!result.ok) {
    return errorResponse(result.status, result.code);
  }
  return NextResponse.json({ reviewId: result.reviewId });
}