/**
 * POST /api/auth/login
 *
 * Verifies email + password, sets a session cookie, returns the user.
 *
 * Failure response is intentionally identical for "no such email" and
 * "wrong password" so the API does not become an enumeration oracle for
 * registered addresses. We log a separate diagnostic event for ops.
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, SESSION_TTL } from "@/lib/auth/session";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/cookies";
import { loginSchema, invalidRequest } from "@/lib/auth/validate";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_json" } },
      { status: 400 }
    );
  }
  const parsed = loginSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(invalidRequest(parsed.error.issues).body, {
      status: 400,
    });
  }
  const { email, password } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);

  // Always run verifyPassword even when no user is found, to keep timing
  // roughly comparable between the two failure modes. The cost is one
  // bcrypt verify (a few ms) per failed login.
  const ok = await verifyPassword(password, user?.passwordHash ?? undefined);
  if (!user || !ok) {
    return NextResponse.json(
      { error: { code: "invalid_credentials" } },
      { status: 401 }
    );
  }

  const { token } = await createSession({
    userId: user.id,
    userAgent: req.headers.get("user-agent"),
    ipHash: null,
  });

  const res = NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email,
        handle: user.handle,
        displayName: user.displayName,
        emailVerified: user.emailVerified,
      },
    },
    { status: 200 }
  );
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL));
  return res;
}