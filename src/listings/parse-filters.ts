/**
 * URL search params → `BrowseFilters` coercion for the browse index.
 *
 * Every field is optional and tolerant of garbage: invalid numbers are
 * dropped, overlong strings are truncated, and out-of-range values are
 * clamped. We never throw on bad input — the page should render with a
 * permissive filter set rather than a 500.
 *
 * YIL-7.
 */
import { z } from "zod";
import { BROWSE_LIMITS, type BrowseFilters } from "./types";
import {
  parseCategoryParam,
  parsePriceToCents,
} from "./format";

const RawFilters = z.object({
  category: z.string().trim().max(500).optional(),
  priceMin: z.string().trim().max(40).optional(),
  priceMax: z.string().trim().max(40).optional(),
  location: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(BROWSE_LIMITS.pageMax).optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(BROWSE_LIMITS.pageSizeMin)
    .max(BROWSE_LIMITS.pageSizeMax)
    .optional(),
});

/**
 * Parse an `URLSearchParams`-like input into a clean `BrowseFilters`.
 * Designed to work with both `URLSearchParams` (Request URL) and the
 * Next.js `searchParams` prop, both of which support `.get()`.
 */
export function parseFilters(
  source: { get(name: string): string | null }
): BrowseFilters {
  const raw = RawFilters.safeParse({
    category: source.get("category") ?? undefined,
    priceMin: source.get("priceMin") ?? undefined,
    priceMax: source.get("priceMax") ?? undefined,
    location: source.get("location") ?? undefined,
    page: source.get("page") ?? undefined,
    pageSize: source.get("pageSize") ?? undefined,
  });

  // Bad input → permissive default. We do this because filter URLs are
  // shared (people copy-paste them) and we'd rather show *something* than
  // bounce the user to an error page.
  if (!raw.success) {
    return {};
  }

  const out: BrowseFilters = {};

  const slugs = parseCategoryParam(raw.data.category);
  if (slugs.length > 0) out.categorySlugs = slugs;

  const priceMin = raw.data.priceMin ? parsePriceToCents(raw.data.priceMin) : null;
  if (priceMin !== null) {
    out.priceMinCents = clampPrice(priceMin);
  }

  const priceMax = raw.data.priceMax ? parsePriceToCents(raw.data.priceMax) : null;
  if (priceMax !== null) {
    out.priceMaxCents = clampPrice(priceMax);
  }

  // Reject inverted ranges up-front; the DB will return nothing useful.
  if (
    typeof out.priceMinCents === "number" &&
    typeof out.priceMaxCents === "number" &&
    out.priceMinCents > out.priceMaxCents
  ) {
    out.priceMinCents = undefined;
    out.priceMaxCents = undefined;
  }

  if (raw.data.location) {
    out.location = raw.data.location;
  }

  if (raw.data.page) out.page = raw.data.page;
  if (raw.data.pageSize) out.pageSize = raw.data.pageSize;

  return out;
}

function clampPrice(cents: number): number {
  if (!Number.isFinite(cents)) return BROWSE_LIMITS.priceMinCents;
  if (cents < BROWSE_LIMITS.priceMinCents) return BROWSE_LIMITS.priceMinCents;
  if (cents > BROWSE_LIMITS.priceMaxCents) return BROWSE_LIMITS.priceMaxCents;
  return cents;
}

/**
 * Build a URL search params string from a clean filter set. Used by the
 * filter form to construct its `action` URL and by the "clear filters"
 * button to construct the unfiltered URL.
 *
 * Empty / undefined fields are dropped. Numeric values use whole-dollar
 * notation ("1200" not "120000") because humans reading the URL prefer it.
 */
export function buildFiltersQuery(filters: Partial<BrowseFilters>): string {
  const params = new URLSearchParams();
  if (filters.categorySlugs && filters.categorySlugs.length > 0) {
    params.set("category", filters.categorySlugs.join(","));
  }
  if (typeof filters.priceMinCents === "number") {
    params.set("priceMin", String(Math.round(filters.priceMinCents / 100)));
  }
  if (typeof filters.priceMaxCents === "number") {
    params.set("priceMax", String(Math.round(filters.priceMaxCents / 100)));
  }
  if (filters.location) params.set("location", filters.location);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}