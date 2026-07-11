/**
 * Single-listing endpoints.
 *   GET    /api/listings/:id    — fetch (owner-only for non-published).
 *   PATCH  /api/listings/:id    — partial edit. Status transitions via PATCH
 *                                 are limited to `archived`; publish and
 *                                 unpublish are explicit endpoints.
 *   DELETE /api/listings/:id    — hard delete with cascade.
 *
 * Ownership:
 *   - GET: anyone can fetch a `published` listing; drafts/archived/owner-only.
 *   - PATCH/DELETE: must be the seller.
 */
import { NextResponse } from "next/server";
import { requireSeller } from "@/lib/auth";
import {
  deleteListing,
  getListingById,
  updateListing,
} from "@/listings/repository";
import { listingPatchInput } from "@/listings/validation";

type Ctx = { params: { id: string } };

export async function GET(req: Request, { params }: Ctx) {
  const listing = await getListingById(params.id);
  if (!listing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (listing.status !== "published") {
    // Owner-only path. We still go through `requireSeller` so the same
    // auth surface applies; the dashboard already sends the cookie.
    const seller = await requireSeller(req);
    if (seller instanceof NextResponse) return seller;
    if (seller.id !== listing.sellerId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  return NextResponse.json(listing);
}

export async function PATCH(req: Request, { params }: Ctx) {
  const seller = await requireSeller(req);
  if (seller instanceof NextResponse) return seller;

  const existing = await getListingById(params.id);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (existing.sellerId !== seller.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = listingPatchInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Empty PATCH is a no-op, but we still return the current row so the
  // client can re-sync without an extra GET round-trip.
  const updated = await updateListing(params.id, parsed.data);
  if (!updated) {
    // Race: row was deleted between the existence check and the update.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}

export async function DELETE(req: Request, { params }: Ctx) {
  const seller = await requireSeller(req);
  if (seller instanceof NextResponse) return seller;

  const existing = await getListingById(params.id);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (existing.sellerId !== seller.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ok = await deleteListing(params.id);
  if (!ok) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 204 with no body — fetch will get 404 after this.
  return new NextResponse(null, { status: 204 });
}
