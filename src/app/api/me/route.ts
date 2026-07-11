/**
 * GET /api/me
 *
 * Returns the currently signed-in user, or 401 if there is no valid
 * session. The endpoint is intentionally tiny so any frontend can use it
 * as the canonical "who am I?" probe on page load.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { verifySessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const cookieValue = readCookie(req);
  const ctx = cookieValue ? await verifySessionToken(cookieValue) : null;
  if (!ctx) {
    return NextResponse.json(
      { error: { code: "unauthenticated" } },
      { status: 401 }
    );
  }
  const u = ctx.user;
  return NextResponse.json(
    {
      user: {
        id: u.id,
        email: u.email,
        handle: u.handle,
        displayName: u.displayName,
        emailVerified: u.emailVerified,
        role: u.role,
      },
    },
    { status: 200 }
  );
}