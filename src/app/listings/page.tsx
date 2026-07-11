/**
 * Public listing browse — `/listings`.
 *
 * Server component. Reads filters from the URL search params (parsed via
 * `parseFilters`), runs a single round-trip browse query, and renders a
 * filter sidebar + result grid. The filter sidebar is a server-rendered
 * `<form>` that submits via GET so URLs are shareable and bookmarkable.
 *
 * YIL-7.
 */
import Link from "next/link";
import { db } from "@/db/client";
import { browse } from "@/listings/repo";
import {
  buildFiltersQuery,
  parseFilters,
} from "@/listings/parse-filters";
import {
  formatMoney,
  formatRelativePostedAt,
} from "@/listings/format";
import type { BrowseFilters, ListingSummary } from "@/listings/types";
import {
  CATEGORIES,
  CATEGORY_OPTIONS,
} from "./categories";
import styles from "./listings.module.css";

/* Next.js: re-evaluate on every request so filter changes don't get
 * served from a stale static cache. The data set is small at MVP scale. */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function pickFilters(params: SearchParams): BrowseFilters {
  // Normalize the Next.js searchParams shape (which is `string | string[]`)
  // into the URLSearchParams-like shape `parseFilters` expects.
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = firstParam(value);
    if (v !== undefined && v !== "") usp.set(key, v);
  }
  return parseFilters(usp);
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const filters = pickFilters(searchParams ?? {});
  const result = await browse(db, filters);
  const { items, total, page, pageSize } = result;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Browse listings</h1>
        <p className={styles.count}>
          {total === 0
            ? "No listings match your filters."
            : `${total.toLocaleString()} listing${total === 1 ? "" : "s"}`}
        </p>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <FilterForm filters={filters} />
        </aside>

        <section className={styles.results}>
          {items.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              <ul className={styles.grid}>
                {items.map((item) => (
                  <li key={item.id} className={styles.card}>
                    <ListingCard item={item} />
                  </li>
                ))}
              </ul>
              <Pagination
                page={page}
                totalPages={totalPages}
                filters={filters}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Server-rendered filter form (GET, shareable URLs)                          */
/* -------------------------------------------------------------------------- */

function FilterForm({ filters }: { filters: BrowseFilters }) {
  const selectedCategories = new Set(filters.categorySlugs ?? []);
  const priceMinDollars =
    typeof filters.priceMinCents === "number"
      ? String(Math.round(filters.priceMinCents / 100))
      : "";
  const priceMaxDollars =
    typeof filters.priceMaxCents === "number"
      ? String(Math.round(filters.priceMaxCents / 100))
      : "";

  return (
    <form method="get" action="/listings" className={styles.form}>
      <div className={styles.formGroup}>
        <h2 className={styles.formTitle}>Category</h2>
        <ul className={styles.checkList}>
          {CATEGORY_OPTIONS.map((opt) => (
            <li key={opt.slug}>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  name="category"
                  value={opt.slug}
                  defaultChecked={selectedCategories.has(opt.slug)}
                />
                <span>{opt.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.formGroup}>
        <h2 className={styles.formTitle}>Price (USD)</h2>
        <div className={styles.priceRow}>
          <input
            type="number"
            name="priceMin"
            inputMode="numeric"
            min={0}
            placeholder="Min"
            defaultValue={priceMinDollars}
            className={styles.priceInput}
            aria-label="Minimum price in dollars"
          />
          <span className={styles.priceSep}>—</span>
          <input
            type="number"
            name="priceMax"
            inputMode="numeric"
            min={0}
            placeholder="Max"
            defaultValue={priceMaxDollars}
            className={styles.priceInput}
            aria-label="Maximum price in dollars"
          />
        </div>
      </div>

      <div className={styles.formGroup}>
        <h2 className={styles.formTitle}>Location</h2>
        <input
          type="text"
          name="location"
          placeholder="City, state…"
          defaultValue={filters.location ?? ""}
          className={styles.textInput}
          maxLength={120}
          aria-label="Location filter"
        />
      </div>

      <div className={styles.formActions}>
        <button type="submit" className={styles.submit}>
          Apply filters
        </button>
        {(filters.categorySlugs?.length ||
          filters.priceMinCents !== undefined ||
          filters.priceMaxCents !== undefined ||
          filters.location) && (
          <Link href="/listings" className={styles.clear}>
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Card                                                                       */
/* -------------------------------------------------------------------------- */

function ListingCard({ item }: { item: ListingSummary }) {
  const cover = item.coverImage;
  return (
    <Link href={`/listings/${item.id}`} className={styles.cardLink}>
      <div className={styles.cover}>
        {cover ? (
          // Plain <img> for the MVP — the detail page is where we'd put
          // `next/image` once the image CDN is wired (YIL-11). Keeping
          // it consistent here avoids two image strategies.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover.url}
            alt={cover.altText || item.title}
            loading="lazy"
          />
        ) : (
          <PlaceholderCover title={item.title} />
        )}
      </div>
      <div className={styles.cardBody}>
        <h3 className={styles.cardTitle}>{item.title}</h3>
        <div className={styles.price}>
          {formatMoney(item.price.amountCents, item.price.currency)}
        </div>
        <div className={styles.meta}>
          {item.location && <span className={styles.location}>📍 {item.location}</span>}
          <span className={styles.posted}>
            · {formatRelativePostedAt(item.createdAt)}
          </span>
        </div>
        {item.categories.length > 0 && (
          <ul className={styles.tagList}>
            {item.categories.slice(0, 3).map((c) => (
              <li key={c.id} className={styles.tag}>
                {c.name}
              </li>
            ))}
          </ul>
        )}
        <div className={styles.seller}>by {item.seller.displayName}</div>
      </div>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*  Pagination                                                                 */
/* -------------------------------------------------------------------------- */

function Pagination({
  page,
  totalPages,
  filters,
}: {
  page: number;
  totalPages: number;
  filters: BrowseFilters;
}) {
  if (totalPages <= 1) return null;
  const prevFilters: BrowseFilters = { ...filters, page: Math.max(1, page - 1) };
  const nextFilters: BrowseFilters = {
    ...filters,
    page: Math.min(totalPages, page + 1),
  };
  return (
    <nav className={styles.pager} aria-label="Pagination">
      {page > 1 ? (
        <Link
          href={`/listings${buildFiltersQuery(prevFilters)}`}
          className={styles.pagerLink}
          rel="prev"
        >
          ← Previous
        </Link>
      ) : (
        <span className={styles.pagerDisabled}>← Previous</span>
      )}
      <span className={styles.pagerCount}>
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link
          href={`/listings${buildFiltersQuery(nextFilters)}`}
          className={styles.pagerLink}
          rel="next"
        >
          Next →
        </Link>
      ) : (
        <span className={styles.pagerDisabled}>Next →</span>
      )}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/*  Empty state                                                                */
/* -------------------------------------------------------------------------- */

function EmptyState() {
  return (
    <div className={styles.empty}>
      <h2>No listings match your filters</h2>
      <p>
        Try removing a filter or{" "}
        <Link href="/listings" className={styles.emptyLink}>
          browse all listings
        </Link>
        .
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Cover placeholder (offline-safe gradient)                                  */
/* -------------------------------------------------------------------------- */

function PlaceholderCover({ title }: { title: string }) {
  // Deterministic hash → gradient. Same title always picks the same colours.
  const hash = Array.from(title).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hue1 = hash % 360;
  const hue2 = (hash * 7) % 360;
  return (
    <div
      className={styles.placeholder}
      style={{
        background: `linear-gradient(135deg, hsl(${hue1} 50% 65%), hsl(${hue2} 55% 45%))`,
      }}
      aria-label={title}
      role="img"
    >
      <span>{title.slice(0, 2).toUpperCase()}</span>
    </div>
  );
}