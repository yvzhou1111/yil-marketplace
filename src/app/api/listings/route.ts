/**
 * Listing collection endpoint.
 *   GET  /api/listings                — public browse with filters
 *                                       (YIL-7). Returns the same payload
 *                                       shape as the `/listings` page.
 *   POST /api/listings                — create a draft listing for the
 *                                       authenticated seller.
 *   GET  /api/listings/mine           — list the authenticated seller's
 *                                       listings, all statuses. (Mounted
 *                                       at /api/listings/mine via the
 *                                       dedicated sub-route file.)
 *
 * Ownership and auth are enforced at the route boundary; the repository
 * stays a thin DB wrapper.
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { browse } from "@/listings/repo";
import { parseFilters } from "@/listings/parse-filters";
import { requireSeller } from "@/lib/auth";
import {
  createListing,
  listListingsBySeller,
} from "@/listings/repository";
import { listingDraftInput } from "@/listings/validation";

export const dynamic = "force-dynamic";

/**
 * Public browse. Filters come from the query string and are the same
 * shape the page uses (category, priceMin/Max, location, page, pageSize).
 *
 * YIL-7.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const filters = parseFilters(url.searchParams);
  const result = await browse(db, filters);
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const seller = await requireSeller(req);
  if (seller instanceof NextResponse) return seller;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = listingDraftInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "validation failed",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const row = await createListing({
    sellerId: seller.id,
    title: parsed.data.title,
    description: parsed.data.description,
    amountCents: parsed.data.amountCents,
    currency: parsed.data.currency,
    location: parsed.data.location,
    status: "draft",
  });

  return NextResponse.json(row, { status: 201 });
}
