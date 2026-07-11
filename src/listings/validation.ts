/**
 * Zod schemas for listing API inputs.
 *
 * The DB schema (src/db/schema.ts) is the source of truth for column types,
 * but we re-state the constraints here at the API boundary so:
 *   - We can return 400 with a useful error message before hitting the DB.
 *   - We never trust user input to fit our column constraints silently.
 *   - We can grow the API surface (e.g. partial updates) without round-trips.
 *
 * Money is in cents. Currency is a 3-letter ISO code (uppercased before
 * persistence). Title is trimmed and bounded.
 */
import { z } from "zod";

const currencyRe = /^[A-Z]{3}$/;

export const listingDraftInput = z.object({
  title: z
    .string()
    .trim()
    .min(3, "title must be at least 3 characters")
    .max(140, "title must be 140 characters or fewer"),
  description: z
    .string()
    .trim()
    .max(10_000, "description must be 10000 characters or fewer")
    .default(""),
  amountCents: z
    .number()
    .int("amount must be an integer number of cents")
    .min(0, "amount must be >= 0"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(currencyRe, "currency must be a 3-letter ISO code (e.g. USD)"),
  location: z
    .string()
    .trim()
    .max(120, "location must be 120 characters or fewer")
    .default(""),
});

export const listingPatchInput = listingDraftInput
  .partial()
  .extend({
    /**
     * Status can only be set to `archived` via PATCH; draft/published
     * transitions go through the explicit publish/unpublish endpoints so
     * they can run validation hooks (e.g. publish requires >= 1 image).
     */
    status: z.literal("archived").optional(),
  });

export type ListingDraftInput = z.infer<typeof listingDraftInput>;
export type ListingPatchInput = z.infer<typeof listingPatchInput>;

/**
 * What it takes to publish a listing. Centralised so the publish endpoint
 * and the future "save as published" path agree on the rules.
 */
export function validatePublishable(listing: {
  title: string;
  amountCents: number;
  imageCount: number;
}): { ok: true } | { ok: false; error: string } {
  if (listing.title.trim().length < 3) {
    return { ok: false, error: "title must be at least 3 characters" };
  }
  if (listing.amountCents < 0) {
    return { ok: false, error: "amount must be >= 0" };
  }
  if (listing.imageCount < 1) {
    return { ok: false, error: "a published listing needs at least one image" };
  }
  return { ok: true };
}

export const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB