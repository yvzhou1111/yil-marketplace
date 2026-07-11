/**
 * Auth shim for YIL-10 routes.
 *
 * YIL-4 will own real authentication (email/password or magic-link + session
 * cookie). Until that lands, we identify the caller from a request header:
 *   `x-user-id: <uuid>`
 *
 * The header is trusted *only because* this is a placeholder. When YIL-4
 * ships, every call here is replaced with `getSessionUser()` which reads the
 * signed session cookie. The route handlers themselves do not change.
 *
 * The admin role is granted by an `x-user-role: admin` header for the same
 * reason — YIL-4 will replace this with a real role lookup.
 */
import { NextResponse } from "next/server";

export interface Caller {
  userId: string;
  /** Optional admin flag. Defaults to false. */
  isAdmin: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readHeader(req: Request, name: string): string | null {
  const v = req.headers.get(name);
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Identify the caller from headers. Returns `null` if no user id is
 * present; route handlers should respond with 401 in that case.
 */
export function callerFromHeaders(req: Request): Caller | null {
  const userId = readHeader(req, "x-user-id");
  if (!userId || !UUID_PATTERN.test(userId)) {
    return null;
  }
  const role = readHeader(req, "x-user-role");
  return { userId, isAdmin: role === "admin" };
}

/** Standard 401 response. */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** Standard 403 response. */
export function forbiddenResponse(reason: string): NextResponse {
  return NextResponse.json({ error: "forbidden", reason }, { status: 403 });
}

/**
 * Standard JSON error.
 */
export function errorResponse(
  status: number,
  code: string,
  details?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ error: code, ...details }, { status });
}

/**
 * Validate that a path param is a UUID. Returns the trimmed string or null.
 * Use in route handlers like:
 *   const id = requireUuid(params.id);
 *   if (!id) return errorResponse(400, "bad_id");
 */
export function requireUuid(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  if (!UUID_PATTERN.test(value)) return null;
  return value.toLowerCase();
}