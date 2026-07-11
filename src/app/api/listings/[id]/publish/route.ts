/**
 * POST /api/listings/:id/publish
 *
 * Move a draft listing to `published`. Centralised so the publish-time
 * validation rules (>= 1 image, valid title, non-negative price) are
 * identical for the future "publish from edit page" and any programmatic
 * bulk-publish tools.
 */
import { NextResponse } from "next/server";
import { requireSeller } from "@/lib/auth";
import {
  countImagesForListing,
  getListingById,
  updateListing,
} from "@/listings/repository";
import { applySellerAction } from "@/listings/state";
import { validatePublishable } from "@/listings/validation";

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

  const transition = applySellerAction(listing.status, { type: "publish" });
  if (!transition.ok) {
    return NextResponse.json(
      { error: transition.error },
      { status: 409 },
    );
  }

  const imageCount = await countImagesForListing(listing.id);
  const valid = validatePublishable({
    title: listing.title,
    amountCents: Number(listing.amountCents),
    imageCount,
  });
  if (!valid.ok) {
    return NextResponse.json({ error: valid.error }, { status: 400 });
  }

  const updated = await updateListing(listing.id, {
    status: transition.next,
  });
  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}
