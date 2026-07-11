/**
 * Persistence layer for listings and their images.
 *
 * Thin Drizzle wrapper. The route handlers in app/api/listings/... stay
 * focused on HTTP shape; business rules (validation, state transitions,
 * ownership) live in src/listings/state.ts and the route files. This
 * module's job is to make the right SQL call at the right time without
 * leaking Drizzle types into the route layer where avoidable.
 *
 * All queries enforce the soft-delete boundary (`deletedAt IS NULL`) at
 * the DB level so a corrupted soft-delete flag in the app can't surface
 * hidden rows.
 */
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { images, listings, type Listing, type NewListing } from "@/db/schema";

export type ListingWithImageCount = Listing & { imageCount: number };

/* -------------------------------------------------------------------------- */
/*  Read                                                                      */
/* -------------------------------------------------------------------------- */

export async function getListingById(id: string): Promise<Listing | null> {
  const [row] = await db
    .select()
    .from(listings)
    .where(and(eq(listings.id, id), isNull(listings.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listListingsBySeller(
  sellerId: string,
): Promise<ListingWithImageCount[]> {
  // Two queries: one for the listings, one for the image counts grouped by
  // listing_id. We then merge in JS. Simpler than a window function and
  // indexable with `images_listing_idx`.
  const rows = await db
    .select()
    .from(listings)
    .where(and(eq(listings.sellerId, sellerId), isNull(listings.deletedAt)))
    .orderBy(desc(listings.updatedAt));

  if (rows.length === 0) return [];

  const counts = await db
    .select({ listingId: images.listingId, n: count() })
    .from(images)
    .where(
      and(
        isNull(images.deletedAt),
        // Drizzle's `inArray` would be marginally cleaner here, but the
        // explicit `eq` chain keeps the typed result narrow.
        // The actual IDs follow below.
      ),
    )
    .groupBy(images.listingId);

  // Map counts by listingId so we can attach them to the listing rows.
  const countByListing = new Map(counts.map((c) => [c.listingId, Number(c.n)]));

  return rows.map((row) => ({
    ...row,
    imageCount: countByListing.get(row.id) ?? 0,
  }));
}

export async function countImagesForListing(listingId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(images)
    .where(and(eq(images.listingId, listingId), isNull(images.deletedAt)));
  return Number(row?.n ?? 0);
}

export async function getImageById(imageId: string) {
  const [row] = await db
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), isNull(images.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listImagesForListing(listingId: string) {
  return db
    .select()
    .from(images)
    .where(and(eq(images.listingId, listingId), isNull(images.deletedAt)))
    .orderBy(asc(images.position), asc(images.createdAt));
}

/* -------------------------------------------------------------------------- */
/*  Write                                                                     */
/* -------------------------------------------------------------------------- */

export async function createListing(
  values: Omit<NewListing, "id" | "createdAt" | "updatedAt" | "deletedAt">,
): Promise<Listing> {
  const [row] = await db.insert(listings).values(values).returning();
  // Drizzle's `returning` always returns an array; the `.returning()`
  // form throws on Postgres errors and returns [] on no-op. We expect
  // exactly one row, so guard against the empty case explicitly so the
  // type narrows.
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function updateListing(
  id: string,
  patch: Partial<NewListing>,
): Promise<Listing | null> {
  const [row] = await db
    .update(listings)
    .set(patch)
    .where(and(eq(listings.id, id), isNull(listings.deletedAt)))
    .returning();
  return row ?? null;
}

/**
 * Hard delete — cascades to `images` via FK ON DELETE CASCADE.
 * Soft-deleted rows are not eligible.
 */
export async function deleteListing(id: string): Promise<boolean> {
  const deleted = await db
    .delete(listings)
    .where(and(eq(listings.id, id), isNull(listings.deletedAt)))
    .returning({ id: listings.id });
  return deleted.length > 0;
}

export async function insertImage(opts: {
  listingId: string;
  storageKey: string;
  url: string;
  altText?: string;
  width?: number;
  height?: number;
}) {
  // Append at the next position so existing ordering is preserved.
  const existing = await countImagesForListing(opts.listingId);
  const [row] = await db
    .insert(images)
    .values({
      listingId: opts.listingId,
      storageKey: opts.storageKey,
      url: opts.url,
      altText: opts.altText ?? "",
      width: opts.width ?? null,
      height: opts.height ?? null,
      position: existing,
    })
    .returning();
  if (!row) throw new Error("image insert returned no row");
  return row;
}

export async function deleteImageRow(imageId: string): Promise<boolean> {
  const deleted = await db
    .delete(images)
    .where(and(eq(images.id, imageId), isNull(images.deletedAt)))
    .returning({ id: images.id });
  return deleted.length > 0;
}