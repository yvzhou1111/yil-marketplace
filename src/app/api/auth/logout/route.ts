/**
 * POST /api/auth/logout
 *
 * Revokes the current session in the DB and clears the cookie. Idempotent
 * — calling it without a session is a 204.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { verifySessionToken, revokeSession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  const cookieValue = m ? decodeURIComponent(m[1]) : null;

  if (cookieValue) {
    const ctx = await verifySessionToken(cookieValue);
    if (ctx) {
      await revokeSession(ctx.session.id);
    }
  }

  const res = new NextResponse(null, { status: 204 });
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
  return res;
}