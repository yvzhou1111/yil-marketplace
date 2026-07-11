/**
 * POST /api/reviews/[id]/flag — flag a review for abuse.
 *
 * Anyone (signed in) can flag any visible review. Auto-hide kicks in once
 * the open-flag count reaches the threshold set in src/reviews/state.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { flagReview } from "@/reviews/service";
import {
  callerFromHeaders,
  requireUuid,
  unauthorizedResponse,
  errorResponse,
} from "@/reviews/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const flagSchema = z.object({
  reason: z.enum([
    "spam",
    "harassment",
    "hate",
    "threat",
    "doxxing",
    "off_topic",
    "other",
  ]),
  notes: z.string().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const caller = callerFromHeaders(req);
  if (!caller) return unauthorizedResponse();

  const reviewId = requireUuid(params.id);
  if (!reviewId) return errorResponse(400, "bad_review_id");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json");
  }
  const parsed = flagSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "invalid_body", {
      issues: parsed.error.issues,
    });
  }

  const result = await flagReview(db, {
    reviewId,
    reporterId: caller.userId,
    reason: parsed.data.reason,
    notes: parsed.data.notes,
  });

  if (!result.ok) {
    return errorResponse(result.status, result.code);
  }
  return NextResponse.json(
    {
      flagId: result.flagId,
      openFlagCount: result.openFlagCount,
      autoHidden: result.autoHidden,
    },
    { status: 201 }
  );
}