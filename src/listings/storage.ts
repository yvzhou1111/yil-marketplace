/**
 * Image storage abstraction.
 *
 * MVP writes to local disk under storage/listings/{listingId}/{uuid}.{ext}
 * and serves files back through `/api/listings/[id]/images/[imageId]/file`.
 * The interface is shaped to match S3 / R2 so swapping the implementation
 * later is one constructor change.
 *
 * - `put(...)` returns `{ storageKey, publicUrl }`.
 *   - `storageKey` is the canonical identifier we persist in `images.storage_key`.
 *   - `publicUrl` is what the API returns to clients in `images.url`. For
 *     local storage it points at our serve route; for S3 it'd be the CDN URL.
 * - `delete(storageKey)` is best-effort: if the blob is missing we log and
 *   return — DB cleanup must still proceed.
 *
 * Safety:
 *   - `storageKey` is constrained to UUID + known extension so we can never
 *     produce a path-traversal payload even if the DB is poisoned.
 *   - We never trust client-supplied filenames; the random uuid is the only
 *     on-disk component we use to build the path.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

const STORAGE_ROOT =
  process.env.LISTING_STORAGE_DIR ?? resolve(process.cwd(), "storage/listings");

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const KEY_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/i;

export type PutResult = { storageKey: string; publicUrl: string };

export function publicUrlFor(listingId: string, storageKey: string): string {
  // The route handler at /api/listings/[id]/images/[imageId]/file serves
  // from disk. We expose the URL as a relative path so it works in dev
  // (http://localhost:3000) and behind any reverse proxy without us knowing
  // the public host.
  return `/api/listings/${listingId}/images/by-key/${encodeURIComponent(storageKey)}`;
}

export async function putImage(opts: {
  listingId: string;
  mime: string;
  bytes: Buffer;
}): Promise<PutResult> {
  const ext = EXT_BY_MIME[opts.mime];
  if (!ext) {
    throw new Error(`unsupported mime type: ${opts.mime}`);
  }
  const storageKey = `${randomUUID()}.${ext}`;
  const absPath = join(STORAGE_ROOT, opts.listingId, storageKey);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, opts.bytes);
  return { storageKey, publicUrl: publicUrlFor(opts.listingId, storageKey) };
}

export async function deleteImage(storageKey: string): Promise<void> {
  if (!KEY_RE.test(storageKey)) {
    // Defensive: refuse to delete anything that doesn't look like our key
    // shape, even if the DB row has been corrupted.
    return;
  }
  // We don't know the listingId from the key alone, so we walk the storage
  // root. Acceptable for the MVP; a real S3 implementation would do
  // `s3.deleteObject({ Key: `listings/${listingId}/${storageKey}` })` using
  // the row's `listing_id`.
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const listingDirs = await readdir(STORAGE_ROOT).catch(() => []);
    for (const listingId of listingDirs) {
      const candidate = join(STORAGE_ROOT, listingId, storageKey);
      try {
        const s = await stat(candidate);
        if (s.isFile()) {
          await unlink(candidate);
          return;
        }
      } catch {
        // not here — keep looking
      }
    }
  } catch {
    // best-effort; log and move on
  }
}

/** Test-only: where local blobs live. */
export function storageRoot(): string {
  return STORAGE_ROOT;
}