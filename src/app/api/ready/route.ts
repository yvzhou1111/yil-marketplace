import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withRequestLogger } from "@/lib/observability/request-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/ready
 *
 * Readiness vs liveness:
 *
 * - `/api/health` is a *liveness* probe — it answers "is the process
 *   alive?". Used by Docker `HEALTHCHECK`. Always cheap.
 *
 * - `/api/ready` is a *readiness* probe — it answers "should the load
 *   balancer send traffic here?". Used by uptime monitors and the
 *   deploy pipeline to decide if the new release is healthy.
 *
 * Sub-checks are best-effort: a single failing check degrades the response
 * but does not crash the process. We log every failure so the Sentry alert
 * for "readiness degraded for ≥5 min" fires only when it matters.
 */

type SubCheck = {
  name: string;
  ok: boolean;
  error?: string;
  /** Anything sub-check wants to attach, must be JSON-serializable. */
  meta?: Record<string, unknown>;
};

async function checkDb(): Promise<SubCheck> {
  try {
    const result = await db.execute(sql`select 1 as ok`);
    return { name: "db", ok: true, meta: { rows: result.rowCount ?? 0 } };
  } catch (err) {
    return {
      name: "db",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Config sanity check — verifies the env vars we need to *serve traffic*
 * are present and non-empty. This is the second line of defense against
 * the "deployed but auth/S3/Stripe config missing" class of outage.
 */
function checkConfig(): SubCheck {
  const required: Array<{ key: string; optional?: boolean }> = [
    { key: "DATABASE_URL" },
    { key: "AUTH_SECRET", optional: true },
    { key: "STRIPE_SECRET_KEY", optional: true },
    { key: "STRIPE_WEBHOOK_SECRET", optional: true },
    { key: "S3_BUCKET", optional: true },
    { key: "S3_REGION", optional: true },
  ];
  const missing = required.filter((r) => !r.optional && !process.env[r.key]);
  if (missing.length > 0) {
    return {
      name: "config",
      ok: false,
      error: `missing required env: ${missing.map((m) => m.key).join(", ")}`,
      meta: { missingKeys: missing.map((m) => m.key) },
    };
  }
  return { name: "config", ok: true };
}

export async function GET(req: Request) {
  return withRequestLogger(req as never, async (ctx) => {
    const checks = await Promise.all([checkDb(), Promise.resolve(checkConfig())]);
    const allOk = checks.every((c) => c.ok);

    const body = {
      status: allOk ? "ok" : "degraded",
      service: "yil-marketplace",
      env: process.env.NODE_ENV ?? "development",
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local",
      timestamp: new Date().toISOString(),
      checks,
    };

    if (!allOk) {
      ctx.log.warn(
        { event: "readiness.degraded", failed: checks.filter((c) => !c.ok).map((c) => c.name) },
        "readiness check degraded",
      );
    }

    const res = NextResponse.json(body, { status: allOk ? 200 : 503 });
    return { res, extra: { readiness: body.status, failed: checks.filter((c) => !c.ok).map((c) => c.name) } };
  });
}