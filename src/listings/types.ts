/**
 * Public-facing types for the YIL marketplace browse + detail surfaces.
 *
 * These types are the contract between the data layer (src/listings/repo.ts)
 * and the UI. They are deliberately narrower than the Drizzle row types:
 *   - Money is exposed as `priceCents` + `currency` so callers don't have to
 *     re-parse anything. Display formatting lives in src/listings/format.ts.
 *   - Seller info is a flat profile, never the full `users` row (which carries
 *     bcrypt hashes and other auth-only fields).
 *   - Categories are a flat list of `CategoryRef`s (id + slug + name) rather
 *     than a tree — the browse index doesn't need hierarchy.
 *
 * Why a separate module rather than deriving from the schema:
 *   - The schema includes auth-only fields (passwordHash, tokenHash, etc.)
 *     that we never want to leak into a server-rendered page or JSON API.
 *   - The browse index wants denormalised rows (cover image + seller display
 *     name) so the page can render a single round-trip.
 *
 * YIL-7.
 */

/** A money amount, stored as integer minor units. Never use floats. */
export type Money = {
  amountCents: number;
  currency: string;
};

/** Lightweight public profile — what the browse/detail pages can show. */
export type SellerProfile = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** ISO timestamp; used for "Member since YYYY" on the detail page. */
  memberSince: string;
  /**
   * Email used by the public "Contact seller" CTA. This is the seller's
   * preferred contact address; in production this should be a per-listing
   * routing address or a contact-request form (see TODO in detail page),
   * not the raw auth email. For YIL-7 MVP we surface it directly because
   * it is the simplest thing that meets the spec.
   */
  contactEmail: string;
};

/** A category as referenced from a listing. Flat — no tree. */
export type CategoryRef = {
  id: string;
  slug: string;
  name: string;
};

/** One image attached to a listing, ordered by `position` ASC. */
export type ListingImage = {
  id: string;
  url: string;
  altText: string;
  width: number | null;
  height: number | null;
  position: number;
};

/**
 * A single row in the browse index. Includes the cover image and seller
 * display name so the page can render with a single DB round-trip.
 */
export type ListingSummary = {
  id: string;
  title: string;
  /** Always `published` on the browse surface — drafts are not listed. */
  status: "published";
  price: Money;
  location: string;
  createdAt: string;
  categories: CategoryRef[];
  seller: Pick<SellerProfile, "id" | "handle" | "displayName">;
  coverImage: ListingImage | null;
};

/**
 * Full listing detail — everything the detail page needs.
 * Distinct from `ListingSummary` so we can change one without touching
 * the other; right now the difference is mainly the gallery array and
 * the description.
 */
export type ListingDetail = Omit<ListingSummary, "coverImage"> & {
  description: string;
  gallery: ListingImage[];
  seller: SellerProfile;
};

/**
 * Filters accepted by the browse index. Every field is optional; missing
 * filters mean "no constraint". Values are validated / coerced at the
 * boundary (the route handler), not here — this is the *parsed* shape
 * after the URL search params are interpreted.
 */
export type BrowseFilters = {
  /** Category slugs. Multiple = OR (a listing matches if it has ANY of them). */
  categorySlugs?: string[];
  /** Inclusive lower bound on price. Both bounds use the listing's currency. */
  priceMinCents?: number;
  /** Inclusive upper bound on price. */
  priceMaxCents?: number;
  /** Case-insensitive substring match on `listings.location`. */
  location?: string;
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Items per page. Defaults to 24. Capped server-side. */
  pageSize?: number;
};

/** Result envelope from the browse query. */
export type BrowseResult = {
  items: ListingSummary[];
  /** Total matches across all pages. Used by the pager. */
  total: number;
  /** Echo of the applied filters (for rendering "active filter" pills). */
  filters: BrowseFilters;
  page: number;
  pageSize: number;
};

/** Bounds applied during URL → filter coercion. */
export const BROWSE_LIMITS = {
  pageSizeMin: 1,
  pageSizeMax: 48,
  pageSizeDefault: 24,
  pageMax: 500, // safety against `?page=999999` DoS
  priceMinCents: 0,
  priceMaxCents: 100_000_00, // 100k of whatever currency unit
} as const;