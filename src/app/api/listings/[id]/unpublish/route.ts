/**
 * POST /api/listings/:id/unpublish
 *
 * Move a published listing back to `draft`. The reverse of publish; no
 * additional validation since unpublish can only originate from `published`
 * and we never delete an unsold listing's images as part of unpublishing.
 */
import { NextResponse } from "next/server";
import { requireSeller } from "@/lib/auth";
import {
  getListingById,
  updateListing,
} from "@/listings/repository";
import { applySellerAction } from "@/listings/state";

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx) {
  const seller = await requireSeller(req);
  if (seller instanceof NextResponse) return seller;

  const listing = await getListingById(params.id);
  if (!listing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (listing.sellerId !== seller.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const transition = applySellerAction(listing.status, {
    type: "unpublish",
  });
  if (!transition.ok) {
    return NextResponse.json(
      { error: transition.error },
      { status: 409 },
    );
  }

  const updated = await updateListing(listing.id, {
    status: transition.next,
  });
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}
