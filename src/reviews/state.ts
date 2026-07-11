/**
 * Pure state-machine and eligibility logic for reviews.
 *
 * Kept free of Drizzle, Next, and the network so we can unit-test it
 * without booting Postgres. The API routes are thin wrappers that pull
 * rows from the DB and delegate decisions to this module.
 *
 * The order state machine lives in `src/orders/state-machine.ts` (YIL-14).
 * This module re-exports the parts the reviews module needs (the enum,
 * the state type, `canTransition`, `nextStates`, `isReviewable`) so the
 * rest of the reviews code doesn't have to change when the order state
 * machine grows. If you need to read or mutate the state machine, go to
 * that file — review-specific concerns (role enforcement, body
 * normalization, flag thresholds, moderator actions) are documented
 * below.
 *
 *     initiated ──► paid ──► fulfilled ──► completed
 *         │           │           │             │
 *         ▼           ▼           ▼             ▼
 *     cancelled   cancelled   disputed      disputed
 *                                 │
 *                                 ▼
 *                       completed | cancelled   (admin resolves)
 *
 * Reviews can only be written once an order is `completed`. `disputed` blocks
 * reviews on purpose: while a dispute is open the system needs to be neutral,
 * not a venue for retaliation. After the dispute resolves (out of scope for
 * YIL-10), the order stays `disputed` — it does not auto-promote to
 * `completed`. Operators can transition manually if appropriate.
 */

import {
  ORDER_STATES,
  type OrderState,
  canTransition,
  nextStates,
  isReviewable,
  actionsAvailableFrom,
} from "@/orders/state-machine";

export {
  ORDER_STATES,
  type OrderState,
  canTransition,
  nextStates,
  isReviewable,
  actionsAvailableFrom,
};

export type ReviewRole = "buyer" | "seller";

/**
 * Pure: is `userId` allowed to write a review of `role` for `order`?
 *
 * Rules:
 *   1. The order must be `completed`.
 *   2. The reviewer must be a party to the order (buyer or seller).
 *   3. `role` must match the reviewer's side: the buyer writes `buyer`
 *      reviews (about the seller); the seller writes `seller` reviews
 *      (about the buyer). We never allow a reviewer to pick a role that
 *      doesn't match their side — this prevents the seller writing a
 *      "buyer" review of themselves.
 */
export interface OrderSides {
  buyerId: string;
  sellerId: string;
  state: OrderState;
}

export type ReviewEligibility =
  | { ok: true; revieweeId: string }
  | { ok: false; reason: ReviewBlockedReason };

export type ReviewBlockedReason =
  | "wrong_state"
  | "not_a_party"
  | "role_mismatch";

export function checkReviewEligibility(
  order: OrderSides,
  userId: string,
  role: ReviewRole
): ReviewEligibility {
  if (!isReviewable(order.state)) {
    return { ok: false, reason: "wrong_state" };
  }

  const isBuyer = userId === order.buyerId;
  const isSeller = userId === order.sellerId;

  if (!isBuyer && !isSeller) {
    return { ok: false, reason: "not_a_party" };
  }

  // buyer reviews seller → role "buyer" (the reviewer's POV).
  // seller reviews buyer → role "seller" (the reviewer's POV).
  if (role === "buyer" && !isBuyer) {
    return { ok: false, reason: "role_mismatch" };
  }
  if (role === "seller" && !isSeller) {
    return { ok: false, reason: "role_mismatch" };
  }

  const revieweeId = role === "buyer" ? order.sellerId : order.buyerId;
  return { ok: true, revieweeId };
}

/**
 * Pure: rating validation. Caller-supplied rating must be an integer in
 * [1, 5]. We reject NaN, floats, and out-of-range values; the DB has a
 * matching CHECK constraint as the last line of defense.
 */
export function isValidRating(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

/**
 * Pure: validate a review submission body. Centralised so route handlers
 * don't reinvent trimming rules.
 */
export interface ReviewSubmission {
  rating: number;
  body?: string;
}

export type ReviewSubmissionResult =
  | { ok: true; normalized: { rating: number; body: string } }
  | { ok: false; reason: "invalid_rating" | "body_too_long" };

export const MAX_REVIEW_BODY = 2000;

export function normalizeReviewSubmission(
  input: ReviewSubmission
): ReviewSubmissionResult {
  if (!isValidRating(input.rating)) {
    return { ok: false, reason: "invalid_rating" };
  }
  const rawBody = input.body ?? "";
  const trimmed = rawBody.trim();
  if (trimmed.length > MAX_REVIEW_BODY) {
    return { ok: false, reason: "body_too_long" };
  }
  return { ok: true, normalized: { rating: input.rating, body: trimmed } };
}

/**
 * Pure: when a moderator decides on a flagged review, what state change
 * is requested? Returns null for unsupported actions.
 *
 *  - `hide`   → soft-hide the review (hidden_at = now)
 *  - `restore` → clear hidden_at on a previously hidden review
 *  - `dismiss` → resolve all open flags on the review without hiding it
 */
export type ModerationAction = "hide" | "restore" | "dismiss";

export function isModerationAction(value: unknown): value is ModerationAction {
  return value === "hide" || value === "restore" || value === "dismiss";
}

/**
 * Pure: should a flag escalation auto-hide the review? We use the simple
 * threshold rule: 3 or more distinct reporters on a single review hides it
 * until a human moderator restores it. The threshold is intentionally low
 * because we want the first wave of abusive reviews to be quarantined
 * quickly, and the cost of a false-positive is just a hidden review (the
 * moderator can `restore`).
 */
export const AUTO_HIDE_FLAG_THRESHOLD = 3;

export function shouldAutoHide(openFlagCount: number): boolean {
  return openFlagCount >= AUTO_HIDE_FLAG_THRESHOLD;
}