/**
 * POST /api/auth/magic/verify
 *
 * Body: { token }. Consumes the magic link token, ensures the user exists
 * (creating one on-the-fly if the link was for an unknown email — the
 * passwordless sign-up flow), marks `email_verified = true`, and sets a
 * session cookie.
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  consumeMagicLink,
  type MagicLinkPurpose,
} from "@/lib/auth/magicLink";
import { createSession, SESSION_TTL } from "@/lib/auth/session";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/cookies";
import { magicVerifySchema, invalidRequest } from "@/lib/auth/validate";
import { sha256Hex } from "@/lib/auth/crypto";

export const runtime = "nodejs";

async function uniqueHandle(email: string): Promise<string> {
  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const truncated = base.slice(0, 28) || "user";
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? truncated : `${truncated}_${i}`;
    const [hit] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, candidate))
      .limit(1);
    if (!hit) return candidate;
  }
  return `${truncated}_${sha256Hex(email).slice(0, 6)}`;
}

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
  const parsed = magicVerifySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(invalidRequest(parsed.error.issues).body, {
      status: 400,
    });
  }
  const { token } = parsed.data;
  const purpose: MagicLinkPurpose = "signin";

  const consumed = await consumeMagicLink({
    rawToken: token,
    purpose,
  });
  if (!consumed) {
    return NextResponse.json(
      { error: { code: "invalid_or_expired_token" } },
      { status: 400 }
    );
  }

  let [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, consumed.email), isNull(users.deletedAt)))
    .limit(1);

  if (!user) {
    const handle = await uniqueHandle(consumed.email);
    [user] = await db
      .insert(users)
      .values({
        email: consumed.email,
        passwordHash: null,
        handle,
        displayName: consumed.email.split("@")[0],
        emailVerified: true,
      })
      .returning();
  } else if (!user.emailVerified) {
    [user] = await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, user.id))
      .returning();
  }

  const { token: jwt } = await createSession({
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
  res.cookies.set(SESSION_COOKIE, jwt, sessionCookieOptions(SESSION_TTL));
  return res;
}