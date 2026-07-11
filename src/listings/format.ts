/**
 * Pure formatters used by the browse + detail pages.
 *
 * Kept free of I/O and React so they can be unit-tested without rendering
 * or hitting the DB. If a formatter needs to read locale state, surface
 * it as an argument — don't reach for module-scope globals.
 *
 * YIL-7.
 */

/* -------------------------------------------------------------------------- */
/*  Money                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Format a money value for display: "$1,250.00" or "€42.00".
 *
 * - `Intl.NumberFormat` is used so currency symbols and digit grouping
 *   follow the locale. We default to `en-US` for deterministic output in
 *   tests and a consistent surface for the MVP.
 * - The currency code (USD / EUR / …) is the formatter's input; if a
 *   listing has an unknown currency the formatter falls back to a stable
 *   plain-number representation rather than throwing.
 */
export function formatMoney(
  amountCents: number,
  currency: string,
  locale: string = "en-US"
): string {
  const major = amountCents / 100;
  // `currency` may be anything; Intl throws on an unknown currency. Guard.
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(major);
  } catch {
    // Unknown currency code — show the numeric value with the raw code.
    return `${major.toFixed(2)} ${currency}`;
  }
}

/** Parse a free-text price input ("$12", "12.50", " 9 ") into integer cents. */
export function parsePriceToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Strip currency symbols, commas, and whitespace; reject anything
  // that isn't a digit / dot / comma.
  const stripped = trimmed.replace(/[^\d.,]/g, "").replace(/,/g, "");
  if (!stripped || !/^\d+(\.\d{1,2})?$/.test(stripped)) return null;
  const [whole, frac = ""] = stripped.split(".");
  const wholeNum = parseInt(whole, 10);
  if (!Number.isFinite(wholeNum)) return null;
  const fracPadded = (frac + "00").slice(0, 2);
  return wholeNum * 100 + parseInt(fracPadded, 10);
}

/* -------------------------------------------------------------------------- */
/*  Location                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a free-text location string for matching.
 *
 * The DB column is a free-text varchar; we trim and collapse whitespace
 * so different inputs ("  Brooklyn, NY  ", "Brooklyn,NY") match the
 * same row. Lower-cased by the caller (ILIKE) — we don't lower-case here
 * because the display function wants the original casing.
 */
export function normalizeLocation(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * Build the LIKE pattern for `location`. The DB uses `ILIKE`, so callers
 * pass the result as the bound parameter; `%` and `_` in user input are
 * escaped so they match literally.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/* -------------------------------------------------------------------------- */
/*  Slug split                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse the `category` URL parameter into a deduped, trimmed slug list.
 * Splits on comma and trims whitespace. Empty entries are dropped.
 *
 *   "  electronics , books ,electronics"  →  ["electronics", "books"]
 */
export function parseCategoryParam(input: string | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  for (const raw of input.split(",")) {
    const slug = raw.trim().toLowerCase();
    if (slug) seen.add(slug);
  }
  return Array.from(seen);
}

/* -------------------------------------------------------------------------- */
/*  Dates                                                                     */
/* -------------------------------------------------------------------------- */

/** "Member since March 2024" — used in the seller card on the detail page. */
export function formatMemberSince(isoDate: string, locale: string = "en-US"): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(d);
}

/** Relative time for a listing's age on a card: "3 days ago". */
export function formatRelativePostedAt(isoDate: string, now: Date = new Date()): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "";
  const deltaMs = now.getTime() - d.getTime();
  if (deltaMs < 0) return "just now";
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.round(mon / 12);
  return `${yr}y ago`;
}
