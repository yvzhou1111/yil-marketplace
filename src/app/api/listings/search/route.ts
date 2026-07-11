/**
 * GET /api/listings/search?q=...&limit=...&offset=...
 *
 * Returns ranked marketplace listings matching `q`. See ADR 0001 and
 * `src/search/postgres-fts.ts` for the implementation strategy.
 *
 * YIL-8.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { PostgresFtsSearchBackend } from "@/search/postgres-fts";

const querySchema = z.object({
  q:      z.string().trim().max(140).optional().default(""),
  limit:  z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    q:      url.searchParams.get("q")      ?? undefined,
    limit:  url.searchParams.get("limit")  ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_query", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { q, limit, offset } = parsed.data;
  if (!q) {
    return NextResponse.json({
      hits: [],
      backend: "postgres-fts",
      query: { q, limit, offset },
    });
  }

  const backend = new PostgresFtsSearchBackend(db);
  const result = await backend.search({ text: q, limit, offset });

  return NextResponse.json({
    ...result,
    query: { q, limit, offset },
  });
}