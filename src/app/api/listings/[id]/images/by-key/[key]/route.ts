/**
 * GET /api/listings/:id/images/by-key/:key
 *
 * Serves the image blob from local disk. Used by `images.url` until the
 * storage layer migrates to S3/CDN; kept here so the dev experience is
 * self-contained.
 *
 * Path component is the storage_key (uuid + extension). We resolve it
 * strictly under the per-listing directory to prevent traversal even if
 * the URL is hand-crafted.
 */
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, normalize, sep } from "node:path";
import { storageRoot } from "@/listings/storage";
import { getImageById, getListingById } from "@/listings/repository";

type Ctx = { params: { id: string; key: string } };

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(_req: Request, { params }: Ctx) {
  const decoded = decodeURIComponent(params.key);
  // Strict shape check — refuses anything that doesn't look like a uuid + ext.
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(decoded)) {
    return NextResponse.json({ error: "bad key" }, { status: 400 });
  }

  const listing = await getListingById(params.id);
  if (!listing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Verify the image belongs to this listing (don't serve blind by key).
  const image = await getImageByIdForListing(listing.id, decoded);
  if (!image) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const expectedDir = resolve(storageRoot(), listing.id);
  const fullPath = normalize(join(expectedDir, decoded));
  if (!fullPath.startsWith(expectedDir + sep) && fullPath !== expectedDir) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const s = await stat(fullPath);
    if (!s.isFile()) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const ext = decoded.split(".").pop()!.toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  // Node's createReadStream + Response is supported in Next.js route
  // handlers. Casting to a ReadableStream-compatible object via Web's
  // `ReadableStream` keeps streaming.
  const nodeStream = createReadStream(fullPath);
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk) =>
        controller.enqueue(
          chunk instanceof Buffer ? new Uint8Array(chunk) : new Uint8Array(Buffer.from(chunk)),
        ),
      );
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
  return new NextResponse(webStream, {
    headers: {
      "content-type": mime,
      "cache-control": "private, max-age=300",
    },
  });
}

/**
 * Helper: does this listing have an image with the given storage_key?
 * Keeps the serving path keyed off the DB row instead of trusting the URL.
 */
async function getImageByIdForListing(listingId: string, storageKey: string) {
  const { db } = await import("@/db/client");
  const { and, eq, isNull } = await import("drizzle-orm");
  const { images } = await import("@/db/schema");
  const [row] = await db
    .select()
    .from(images)
    .where(
      and(
        eq(images.listingId, listingId),
        eq(images.storageKey, storageKey),
        isNull(images.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
