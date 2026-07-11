import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/health
 * Returns 200 only if Postgres is reachable and the app process is live.
 * Used by CI, the preview environment, and uptime monitoring.
 */
export async function GET() {
  const result: {
    status: "ok" | "degraded";
    service: string;
    db: { ok: boolean; error?: string };
    timestamp: string;
    sha?: string;
  } = {
    status: "ok",
    service: "yil-marketplace",
    db: { ok: true },
    timestamp: new Date().toISOString(),
  };

  try {
    await db.execute(sql`select 1 as ok`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = "degraded";
    result.db = { ok: false, error: message };
    return NextResponse.json(result, { status: 503 });
  }

  if (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA) {
    result.sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA) ?? undefined;
  }

  return NextResponse.json(result, { status: 200 });
}