/**
 * Request / response logging middleware.
 *
 * Generates a request id, logs the request start and finish, attaches the
 * id to the response headers (`x-request-id`) so users can quote it in
 * bug reports, and exposes a `withRequestLogger` helper for use in
 * route handlers.
 *
 * We use Web standard APIs (no `next-connect`) so it works in both
 * Node.js runtime route handlers and the Edge runtime. This matches the
 * Next.js 14 App Router model where `route.ts` exports plain functions.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requestLogger as makeChildLogger } from "@/lib/logger";
import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";

export type RequestContext = {
  requestId: string;
  method: string;
  path: string;
  start: number;
  log: ReturnType<typeof makeChildLogger>;
};

/**
 * Reads or mints a request id, attaches a logger bound with request context,
 * and returns both. Logs the request start event.
 */
export function startRequest(req: NextRequest): {
  ctx: RequestContext;
  headers: Record<string, string>;
} {
  const requestId = req.headers.get(REQUEST_ID_HEADER) ?? randomUUID();
  const method = req.method;
  const path = new URL(req.url).pathname;

  const log = makeChildLogger({
    requestId,
    method,
    route: path,
    event: "request.start",
  });

  const ctx: RequestContext = {
    requestId,
    method,
    path,
    start: Date.now(),
    log,
  };

  log.info(
    { event: "request.start", method, route: path },
    "request received",
  );

  return { ctx, headers: { [REQUEST_ID_HEADER]: requestId } };
}

/**
 * Logs the request finish event with status + duration, and decorates the
 * supplied NextResponse with the request id header so the client can see it.
 */
export function finishRequest(
  ctx: RequestContext,
  res: NextResponse,
  status: number,
  extra?: Record<string, unknown>,
): NextResponse {
  const durationMs = Date.now() - ctx.start;
  ctx.log.info(
    {
      event: "request.finish",
      status,
      durationMs,
      ...extra,
    },
    "request completed",
  );
  res.headers.set(REQUEST_ID_HEADER, ctx.requestId);
  return res;
}

/**
 * Convenience wrapper for route handlers — equivalent to the pattern:
 *
 * ```ts
 * export async function POST(req: NextRequest) {
 *   const { ctx, headers } = startRequest(req);
 *   try {
 *     const body = await req.json();
 *     // ... business logic
 *     const res = NextResponse.json(result, { headers });
 *     return finishRequest(ctx, res, 200);
 *   } catch (err) {
 *     ctx.log.error({ err, event: "request.error" }, "handler failed");
 *     const res = NextResponse.json({ error: "internal" }, { status: 500, headers });
 *     return finishRequest(ctx, res, 500);
 *   }
 * }
 * ```
 */
export async function withRequestLogger<T extends NextResponse>(
  req: NextRequest,
  handler: (ctx: RequestContext) => Promise<{ res: T; extra?: Record<string, unknown> }>,
): Promise<T> {
  const { ctx, headers } = startRequest(req);
  try {
    const { res, extra } = await handler(ctx);
    return finishRequest(ctx, res, res.status, extra) as T;
  } catch (err) {
    ctx.log.error(
      {
        err,
        event: "request.error",
      },
      "handler threw",
    );
    const res = NextResponse.json(
      { error: "internal", requestId: ctx.requestId },
      { status: 500, headers },
    );
    return finishRequest(ctx, res, 500) as T;
  }
}