/**
 * Service layer for reviews and moderation.
 *
 * Pure-ish: takes a Drizzle db handle plus typed inputs and returns
 * structured results. Side-effecting rows stay in this module; route
 * handlers translate results to HTTP. This keeps the routes thin and
 * makes it possible to write integration tests against this layer
 * directly.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import {
  orders,
  reviews,
  reviewFlags,
  reviewModerationActions,
} from "@/db/schema";
import {
  checkReviewEligibility,
  isReviewable,
  normalizeReviewSubmission,
  shouldAutoHide,
  isModerationAction,
  isValidRating,
  AUTO_HIDE_FLAG_THRESHOLD,
  type ModerationAction,
} from "./state";
import type { OrderState, ReviewRole } from "./state";

/**
 * The Drizzle db handle type used by the global client in `src/db/client.ts`.
 * We accept any NodePgDatabase so test code can pass a different handle.
 */
type Db = NodePgDatabase<typeof schema>;

export interface SubmitReviewInput {
  orderId: string;
  reviewerId: string;
  rating: number;
  body?: string;
  role: ReviewRole;
}

export type SubmitReviewResult =
  | { ok: true; reviewId: string }
  | {
      ok: false;
      status: number;
      code:
        | "order_not_found"
        | "wrong_state"
        | "not_a_party"
        | "role_mismatch"
        | "invalid_rating"
        | "body_too_long"
        | "already_reviewed";
    };

/**
 * Submit a review for an order. The caller must be a party to the order,
 * the order must be `completed`, and `role` must match the reviewer's
 * side (buyer → `buyer`, seller → `seller`).
 *
 * Idempotency: the unique index on `(order_id, role)` makes a duplicate
 * review fail with a Postgres unique-violation; we surface that as
 * `already_reviewed`.
 */
export async function submitReview(
  db: Db,
  input: SubmitReviewInput
): Promise<SubmitReviewResult> {
  const normalized = normalizeReviewSubmission({
    rating: input.rating,
    body: input.body,
  });
  if (!normalized.ok) {
    return { ok: false, status: 400, code: normalized.reason };
  }

  const order = await db.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
  });
  if (!order) {
    return { ok: false, status: 404, code: "order_not_found" };
  }

  const eligibility = checkReviewEligibility(
    {
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      state: order.state as OrderState,
    },
    input.reviewerId,
    input.role
  );
  if (!eligibility.ok) {
    const status =
      eligibility.reason === "wrong_state"
        ? 409
        : eligibility.reason === "not_a_party"
          ? 403
          : 403;
    return { ok: false, status, code: eligibility.reason };
  }

  try {
    const inserted = await db
      .insert(reviews)
      .values({
        orderId: order.id,
        reviewerId: input.reviewerId,
        revieweeId: eligibility.revieweeId,
        role: input.role,
        rating: normalized.normalized.rating,
        body: normalized.normalized.body,
      })
      .returning({ id: reviews.id });

    if (!inserted[0]) {
      return { ok: false, status: 500, code: "invalid_rating" };
    }
    return { ok: true, reviewId: inserted[0].id };
  } catch (err) {
    if (isUniqueViolation(err, "reviews_one_per_side_unique")) {
      return { ok: false, status: 409, code: "already_reviewed" };
    }
    throw err;
  }
}

export interface FlagReviewInput {
  reviewId: string;
  reporterId: string;
  reason:
    | "spam"
    | "harassment"
    | "hate"
    | "threat"
    | "doxxing"
    | "off_topic"
    | "other";
  notes?: string;
}

export type FlagReviewResult =
  | {
      ok: true;
      flagId: string;
      openFlagCount: number;
      autoHidden: boolean;
    }
  | {
      ok: false;
      status: number;
      code:
        | "review_not_found"
        | "self_flag"
        | "already_flagged"
        | "cannot_flag_hidden";
    };

/**
 * Flag a review for moderation.
 *
 * Rules:
 *   - The review must exist and not be soft-hidden (you can't pile flags on
 *     something already in the queue).
 *   - A user cannot flag their own review (no self-reporting).
 *   - A reporter can flag the same review once; duplicates return
 *     `already_flagged`.
 *   - If the open-flag count reaches AUTO_HIDE_FLAG_THRESHOLD, the review
 *     is auto-hidden by the same call.
 */
export async function flagReview(
  db: Db,
  input: FlagReviewInput
): Promise<FlagReviewResult> {
  const review = await db.query.reviews.findFirst({
    where: eq(reviews.id, input.reviewId),
  });
  if (!review) {
    return { ok: false, status: 404, code: "review_not_found" };
  }
  if (review.hiddenAt) {
    return { ok: false, status: 409, code: "cannot_flag_hidden" };
  }
  if (review.reviewerId === input.reporterId) {
    return { ok: false, status: 403, code: "self_flag" };
  }

  let flagId: string;
  try {
    const inserted = await db
      .insert(reviewFlags)
      .values({
        reviewId: review.id,
        reporterId: input.reporterId,
        reason: input.reason,
        notes: input.notes ?? "",
      })
      .returning({ id: reviewFlags.id });
    if (!inserted[0]) {
      return { ok: false, status: 500, code: "review_not_found" };
    }
    flagId = inserted[0].id;
  } catch (err) {
    if (isUniqueViolation(err, "review_flags_one_per_reporter")) {
      return { ok: false, status: 409, code: "already_flagged" };
    }
    throw err;
  }

  const openFlagCount = await countOpenFlags(db, review.id);
  const autoHidden =
    !review.hiddenAt && shouldAutoHide(openFlagCount) ? true : false;

  if (autoHidden) {
    await db
      .update(reviews)
      .set({
        hiddenAt: new Date(),
        hiddenReason: `auto-hidden: ${openFlagCount} flags`,
      })
      .where(eq(reviews.id, review.id));
    await db.insert(reviewModerationActions).values({
      reviewId: review.id,
      actorId: input.reporterId,
      action: "auto_hide",
      reason: `${openFlagCount} flags`,
    });
  }

  return { ok: true, flagId, openFlagCount, autoHidden };
}

export interface ModerateReviewInput {
  reviewId: string;
  actorId: string;
  action: ModerationAction;
  reason?: string;
}

export type ModerateReviewResult =
  | { ok: true; reviewId: string }
  | {
      ok: false;
      status: number;
      code: "review_not_found" | "invalid_action" | "no_op";
    };

/**
 * Apply a moderator action.
 *
 *   - `hide`    → soft-hide (hidden_at = now)
 *   - `restore` → clear hidden_at on a previously hidden review
 *   - `dismiss` → resolve all open flags without hiding
 */
export async function moderateReview(
  db: Db,
  input: ModerateReviewInput
): Promise<ModerateReviewResult> {
  if (!isModerationAction(input.action)) {
    return { ok: false, status: 400, code: "invalid_action" };
  }
  const review = await db.query.reviews.findFirst({
    where: eq(reviews.id, input.reviewId),
  });
  if (!review) {
    return { ok: false, status: 404, code: "review_not_found" };
  }

  if (input.action === "hide") {
    if (review.hiddenAt) {
      return { ok: false, status: 409, code: "no_op" };
    }
    await db
      .update(reviews)
      .set({ hiddenAt: new Date(), hiddenReason: input.reason ?? "" })
      .where(eq(reviews.id, review.id));
  } else if (input.action === "restore") {
    if (!review.hiddenAt) {
      return { ok: false, status: 409, code: "no_op" };
    }
    await db
      .update(reviews)
      .set({ hiddenAt: null, hiddenReason: null })
      .where(eq(reviews.id, review.id));
  } else if (input.action === "dismiss") {
    await db
      .update(reviewFlags)
      .set({
        resolvedAt: new Date(),
        resolution: input.reason ?? "dismissed",
      })
      .where(
        and(eq(reviewFlags.reviewId, review.id), isNull(reviewFlags.resolvedAt))
      );
  }

  await db.insert(reviewModerationActions).values({
    reviewId: review.id,
    actorId: input.actorId,
    action: input.action,
    reason: input.reason ?? "",
  });

  return { ok: true, reviewId: review.id };
}

/** Helper: count open (unresolved) flags on a review. */
export async function countOpenFlags(db: Db, reviewId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewFlags)
    .where(and(eq(reviewFlags.reviewId, reviewId), isNull(reviewFlags.resolvedAt)));
  return Number(result[0]?.count ?? 0);
}

/**
 * Postgres unique-violation detection without depending on the pg error
 * type by name. We pattern-match on the message because Drizzle's bundled
 * types vary by version.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  // Postgres SQLSTATE 23505 = unique_violation.
  if (e.code === "23505") {
    return typeof e.message === "string" && e.message.includes(constraint);
  }
  return false;
}

/**
 * Re-export the reviewable check and threshold for routes that need them
 * without importing the state module directly.
 */
export { isReviewable, AUTO_HIDE_FLAG_THRESHOLD } from "./state";