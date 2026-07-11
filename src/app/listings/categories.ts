/**
 * Static category list used by the browse filter form.
 *
 * This intentionally lives in the UI layer (not the DB) because:
 *   - Categories don't change between requests.
 *   - The filter form needs to render the option set before the DB has
 *     been touched (no round-trip before the user picks anything).
 *   - The DB-side categories table (`categories` in `src/db/schema.ts`)
 *     is the source of truth for *which* listings match, but the form
 *     just needs to know what slugs to expose.
 *
 * When the marketplace adds/removes categories, the changes should land
 * in:
 *   - `db/migrations/00NN_categories.sql` (data)
 *   - `scripts/seed.ts` (seed data)
 *   - this file (filter UI)
 *
 * YIL-7.
 */

export type CategoryOption = {
  slug: string;
  name: string;
};

export const CATEGORY_OPTIONS: CategoryOption[] = [
  { slug: "electronics", name: "Electronics" },
  { slug: "fashion", name: "Fashion" },
  { slug: "home", name: "Home & Kitchen" },
  { slug: "books", name: "Books" },
  { slug: "sports", name: "Sports & Outdoors" },
  { slug: "music", name: "Musical Instruments" },
  { slug: "art", name: "Art & Collectibles" },
  { slug: "games", name: "Games & Toys" },
];

/** `slug → name` lookup for the rendered tag pills on each card. */
export const CATEGORIES: Record<string, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((c) => [c.slug, c.name])
);