/**
 * Listings repository — Drizzle-backed reads for the browse and detail
 * pages.
 *
 * Two entry points:
 *
 *   - `browse(db, filters)`     → paged, filtered list with cover image +
 *                                  seller display name. Used by `/listings`.
 *   - `findById(db, id)`        → full listing + gallery + categories +
 *                                  seller profile. Used by `/listings/[id]`.
 *
 * Design notes:
 *
 *   - The browse query is a single round-trip: the listings row + seller
 *     join + aggregate the categories as a JSON array + pick the lowest-
 *     position image as a "cover". This avoids N+1s on a list page that
 *     could have 24 rows.
 *   - `findById` *does* make a few round-trips because it returns a much
 *     richer payload (gallery, full categories, seller bio). One listing
 *     per request is cheap.
 *   - All filters are applied at the DB layer, not in JS, because we
 *     expect volume to grow. The `categories` filter uses `EXISTS` with
 *     an IN clause so it composes with the other `WHERE`s without
 *     requiring a JOIN + DISTINCT.
 *   - We never expose `users.password_hash` / token columns. The seller
 *     subquery selects only the public profile fields.
 *
 * YIL-7.
 */
import { and, asc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  categories,
  images,
  listingCategories,
  listings,
  users,
} from "@/db/schema";
import {
  BROWSE_LIMITS,
  type BrowseFilters,
  type BrowseResult,
  type CategoryRef,
  type ListingDetail,
  type ListingImage,
  type ListingSummary,
  type SellerProfile,
} from "./types";
import { escapeLikePattern, normalizeLocation } from "./format";

/**
 * The slice of the Drizzle handle the repo needs. Declared structurally so
 * the repo is unit-testable with a fake (and so we don't drag the schema
 * types into this module's public surface beyond the few types we re-export).
 */
export type ListingsExecutor = Pick<NodePgDatabase, "execute" | "select">;

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function browse(
  db: ListingsExecutor,
  filters: BrowseFilters
): Promise<BrowseResult> {
  const pageSize = clampInt(
    filters.pageSize ?? BROWSE_LIMITS.pageSizeDefault,
    BROWSE_LIMITS.pageSizeMin,
    BROWSE_LIMITS.pageSizeMax
  );
  const page = clampInt(filters.page ?? 1, 1, BROWSE_LIMITS.pageMax);
  const offset = (page - 1) * pageSize;

  const whereSql = buildBrowseWhereSql(filters);

  /* ---- count: cheap aggregate ignoring the LIMIT/OFFSET ---- */
  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(listings)
    .where(whereSql);
  const total = Number(totalRows[0]?.count ?? 0);

  /* ---- page rows: listing + cover image + seller + categories (JSON) ---- */
  // We hand-write the projection SQL because we need:
  //   - `row_to_json(...)` for the cover image subquery
  //   - `json_agg(...)` for the categories list
  // The Drizzle template-tag API supports this but reads worse than raw SQL.
  const rows = await db.execute<BrowseRow>(sql`
    SELECT
      l.id              AS id,
      l.title           AS title,
      l.status          AS status,
      l.amount_cents    AS amount_cents,
      l.currency        AS currency,
      l.location        AS location,
      l.created_at      AS created_at,
      s.id              AS seller_id,
      s.handle          AS seller_handle,
      s.display_name    AS seller_display_name,
      (
        SELECT row_to_json(i) FROM (
          SELECT id, url, alt_text, width, height, position
          FROM images
          WHERE listing_id = l.id AND deleted_at IS NULL
          ORDER BY position ASC, created_at ASC
          LIMIT 1
        ) i
      ) AS cover_image_json,
      (
        SELECT coalesce(json_agg(
          json_build_object('id', c.id, 'slug', c.slug, 'name', c.name)
          ORDER BY c.name
        ), '[]'::json)
        FROM listing_categories lc
        JOIN categories c ON c.id = lc.category_id
        WHERE lc.listing_id = l.id
      ) AS categories_json
    FROM listings l
    JOIN users s ON s.id = l.seller_id
    WHERE ${whereSql}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${sql.raw(String(pageSize))}
    OFFSET ${sql.raw(String(offset))}
  `);

  const rawRows =
    (rows as unknown as { rows?: BrowseRow[] }).rows ??
    (rows as unknown as BrowseRow[]);

  const items: ListingSummary[] = rawRows.map(rowToSummary);

  return {
    items,
    total,
    filters,
    page,
    pageSize,
  };
}

/**
 * Find one listing by id, with its full gallery, categories, and seller
 * profile. Returns null if the listing doesn't exist, is soft-deleted,
 * or isn't in `published` state (we don't expose drafts to the public).
 */
export async function findById(
  db: ListingsExecutor,
  id: string
): Promise<ListingDetail | null> {
  // 1. The listing row + public seller info.
  const baseRows = await db
    .select({
      id: listings.id,
      title: listings.title,
      description: listings.description,
      amountCents: listings.amountCents,
      currency: listings.currency,
      status: listings.status,
      location: listings.location,
      createdAt: listings.createdAt,
      sellerId: users.id,
      sellerHandle: users.handle,
      sellerDisplayName: users.displayName,
      sellerAvatarUrl: users.avatarUrl,
      sellerEmail: users.email,
      sellerBio: users.bio,
      sellerCreatedAt: users.createdAt,
    })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .where(
      and(
        eq(listings.id, id),
        sql`${listings.deletedAt} IS NULL`,
        eq(listings.status, "published")
      )
    )
    .limit(1);

  const row = baseRows[0];
  if (!row) return null;

  // 2. Gallery (ordered by position ASC, then created_at ASC for stability).
  const galleryRows = await db
    .select({
      id: images.id,
      url: images.url,
      altText: images.altText,
      width: images.width,
      height: images.height,
      position: images.position,
    })
    .from(images)
    .where(and(eq(images.listingId, id), sql`${images.deletedAt} IS NULL`))
    .orderBy(asc(images.position), asc(images.createdAt));

  // 3. Categories for the listing.
  const categoryRows = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
    })
    .from(listingCategories)
    .innerJoin(categories, eq(categories.id, listingCategories.categoryId))
    .where(eq(listingCategories.listingId, id))
    .orderBy(asc(categories.name));

  const seller: SellerProfile = {
    id: row.sellerId,
    handle: row.sellerHandle,
    displayName: row.sellerDisplayName,
    avatarUrl: row.sellerAvatarUrl,
    memberSince: row.sellerCreatedAt.toISOString(),
    contactEmail: row.sellerEmail,
  };

  const gallery: ListingImage[] = galleryRows.map((g) => ({
    id: g.id,
    url: g.url,
    altText: g.altText,
    width: g.width,
    height: g.height,
    position: g.position,
  }));

  return {
    id: row.id,
    title: row.title,
    status: "published",
    description: row.description,
    price: {
      amountCents: row.amountCents,
      currency: row.currency,
    },
    location: row.location,
    createdAt: row.createdAt.toISOString(),
    seller,
    gallery,
    categories: categoryRows as CategoryRef[],
  };
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compose the WHERE clause for the browse query from a parsed filter set.
 *
 * Returns a Drizzle SQL fragment that is *embedded inside* a raw-SQL
 * projection (see `browse()` below). Because the outer SELECT uses full
 * table names — `FROM listings l JOIN users s ON ...` — the fragment
 * refers to columns by their unaliased name (`listings.amount_cents`)
 * so it composes with the surrounding query regardless of how the
 * caller aliases the table.
 *
 * Exported (named) only for tests; not part of the public repo contract.
 */
export function buildBrowseWhereSql(filters: BrowseFilters) {
  const parts = [
    sql`listings.deleted_at IS NULL`,
    sql`listings.status = 'published'`,
  ];
  if (typeof filters.priceMinCents === "number") {
    parts.push(sql`listings.amount_cents >= ${filters.priceMinCents}`);
  }
  if (typeof filters.priceMaxCents === "number") {
    parts.push(sql`listings.amount_cents <= ${filters.priceMaxCents}`);
  }
  if (typeof filters.location === "string" && filters.location.length > 0) {
    const norm = normalizeLocation(filters.location);
    if (norm.length > 0) {
      const pat = `%${escapeLikePattern(norm)}%`;
      parts.push(sql`listings.location ILIKE ${pat}`);
    }
  }
  if (filters.categorySlugs && filters.categorySlugs.length > 0) {
    // EXISTS subquery — composes cleanly with the rest of the WHERE
    // without needing DISTINCT or a JOIN.
    parts.push(sql`EXISTS (
      SELECT 1 FROM listing_categories lc
      JOIN categories c ON c.id = lc.category_id
      WHERE lc.listing_id = listings.id
        AND c.slug IN ${filters.categorySlugs}
    )`);
  }
  return parts.length === 1
    ? parts[0]
    : sql`(${sql.join(parts, sql` AND `)})`;
}

/* -------------------------------------------------------------------------- */
/*  Row → API shape mappers                                                   */
/* -------------------------------------------------------------------------- */

type BrowseRow = {
  id: string;
  title: string;
  status: "draft" | "published" | "sold" | "archived";
  amount_cents: number | string;
  currency: string;
  location: string;
  created_at: Date | string;
  seller_id: string;
  seller_handle: string;
  seller_display_name: string;
  cover_image_json: ImageJson | null;
  categories_json: CategoryJson[] | null;
};

type ImageJson = {
  id: string;
  url: string;
  alt_text: string;
  width: number | null;
  height: number | null;
  position: number;
};

type CategoryJson = {
  id: string;
  slug: string;
  name: string;
};

function rowToSummary(r: BrowseRow): ListingSummary {
  return {
    id: r.id,
    title: r.title,
    // The WHERE restricts to `published` — we still surface this so the UI
    // can render a badge without trusting the client.
    status: "published",
    price: {
      amountCents: Number(r.amount_cents),
      currency: r.currency,
    },
    location: r.location ?? "",
    createdAt: toIso(r.created_at),
    seller: {
      id: r.seller_id,
      handle: r.seller_handle,
      displayName: r.seller_display_name,
    },
    coverImage: rowToImage(r.cover_image_json),
    categories: (r.categories_json ?? []).map(rowToCategory),
  };
}

function rowToImage(j: ImageJson | null): ListingImage | null {
  if (!j) return null;
  return {
    id: j.id,
    url: j.url,
    altText: j.alt_text,
    width: j.width,
    height: j.height,
    position: j.position,
  };
}

function rowToCategory(j: CategoryJson): CategoryRef {
  return {
    id: j.id,
    slug: j.slug,
    name: j.name,
  };
}

function toIso(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// Re-export `gte`, `lte`, `ilike`, etc. so this file's imports stay tidy
// when tree-shaken. (Not strictly necessary; documents intent.)
export const __helpers = { gte, lte, ilike, inArray, eq };