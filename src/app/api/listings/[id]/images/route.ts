/**
 * Image upload endpoint for a listing.
 *   POST   /api/listings/:id/images   — multipart upload; persists one
 *                                       image row at the next position.
 *   GET    /api/listings/:id/images   — list images for one listing.
 *
 * Storage is delegated to src/listings/storage.ts so swapping in S3 later
 * doesn't change this file.
 */
import { NextResponse } from "next/server";
import { requireSeller } from "@/lib/auth";
import {
  getListingById,
  insertImage,
  listImagesForListing,
} from "@/listings/repository";
import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  type AllowedImageMime,
} from "@/listings/validation";
import { putImage } from "@/listings/storage";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const rows = await listImagesForListing(params.id);
  return NextResponse.json({ images: rows });
}

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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "missing 'file' part in multipart body" },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "file is empty" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: `file exceeds ${MAX_IMAGE_BYTES} bytes` },
      { status: 400 },
    );
  }

  const mime = file.type as AllowedImageMime | "";
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(mime)) {
    return NextResponse.json(
      { error: `unsupported mime type: ${file.type || "(empty)"}` },
      { status: 400 },
    );
  }

  const altText = form.get("altText")?.toString() ?? "";

  const bytes = Buffer.from(await file.arrayBuffer());
  const { storageKey, publicUrl } = await putImage({
    listingId: listing.id,
    mime,
    bytes,
  });

  const row = await insertImage({
    listingId: listing.id,
    storageKey,
    url: publicUrl,
    altText,
  });

  return NextResponse.json(row, { status: 201 });
}
