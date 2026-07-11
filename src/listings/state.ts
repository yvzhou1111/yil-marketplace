/**
 * Listing state machine.
 *
 * The DB enum (`listing_status`) is the source of truth: it lists the four
 * legal states. This module pins down the transitions the app will perform
 * and which transitions are *seller-initiated* (so we can audit them later)
 * vs system-initiated.
 *
 *   draft ──publish──► published
 *   published ──unpublish──► draft
 *   draft | published ──archive──► archived
 *
 * `sold` is reserved for YIL-14 (transactions) — a listing transitions to
 * `sold` only when the order reaches `completed`. This module does not allow
 * a seller to set `sold` directly; the route handler rejects PATCH bodies
 * that try.
 */
import { Listing } from "@/db/schema";

export type ListingStatus = Listing["status"];

export type SellerAction =
  | { type: "publish" }
  | { type: "unpublish" }
  | { type: "archive" };

/**
 * Pure transition function. Returns the new status on success or an error
 * string on illegal transition. Tests cover the full transition matrix.
 */
export function applySellerAction(
  current: ListingStatus,
  action: SellerAction,
): { ok: true; next: ListingStatus } | { ok: false; error: string } {
  switch (action.type) {
    case "publish":
      if (current !== "draft") {
        return {
          ok: false,
          error: `cannot publish from "${current}" — only "draft" can be published`,
        };
      }
      return { ok: true, next: "published" };

    case "unpublish":
      if (current !== "published") {
        return {
          ok: false,
          error: `cannot unpublish from "${current}" — only "published" can be unpublished`,
        };
      }
      return { ok: true, next: "draft" };

    case "archive":
      if (current === "archived") {
        return { ok: false, error: "listing is already archived" };
      }
      if (current === "sold") {
        return {
          ok: false,
          error: "cannot archive a sold listing",
        };
      }
      return { ok: true, next: "archived" };
  }
}

/**
 * Fields a seller can edit on a listing. Anything not in this set is
 * silently dropped by `pickEditableFields` and rejected with 400 by the
 * route handler. `seller_id`, `id`, and timestamps can never be edited.
 */
export const EDITABLE_FIELDS = [
  "title",
  "description",
  "amountCents",
  "currency",
  "location",
  "status",
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];