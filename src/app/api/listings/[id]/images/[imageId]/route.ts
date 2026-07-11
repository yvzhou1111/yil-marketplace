/**
 * DELETE /api/listings/:id/images/:imageId
 *
 * Remove a single image from a listing. Cascades: deletes the DB row and
 * the blob on disk (best-effort). Idempotent: deleting an already-gone
 * image returns 204 so the UI can retry without surfacing an error.
 */
import { NextResponse } from "next/server";
import { requireSeller } from "@/lib/auth";
import {
  deleteImageRow,
  getImageById,
  getListingById,
} from "@/listings/repository";
import { deleteImage as deleteBlob } from "@/listings/storage";

type Ctx = { params: { id: string; imageId: string } };

export async function DELETE(req: Request, { params }: Ctx) {
  const seller = await requireSeller(req);
  if (seller instanceof NextResponse) return seller;

  const listing = await getListingById(params.id);
  if (!listing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (listing.sellerId !== seller.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const image = await getImageById(params.imageId);
  if (!image || image.listingId !== listing.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const ok = await deleteImageRow(image.id);
  if (ok) {
    // best-effort, never throws
    await deleteBlob(image.storageKey);
  }
  return new NextResponse(null, { status: 204 });
}
