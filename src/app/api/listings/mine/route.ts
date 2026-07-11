/**
 * GET /api/listings/mine
 *
 * List the authenticated seller's own listings (any status). Used by the
 * seller dashboard at /sell/listings. We don't paginate yet — that lands
 * alongside YIL-7 when the public listing browse gets cursor-based paging
 * and we share the helpers.
 */
import { NextResponse } from "next/server";
import { requireSeller } from "@/lib/auth";
import { listListingsBySeller } from "@/listings/repository";

export async function GET(req: Request) {
  const seller = await requireSeller(req);
  if (seller instanceof NextResponse) return seller;

  const rows = await listListingsBySeller(seller.id);
  return NextResponse.json({ listings: rows });
}
