/**
 * POST /api/auth/register
 *
 * Creates a new user with email + password. Sets a session cookie on
 * success. The user is `emailVerified: false` until they click the
 * verification email (separate route under `/api/auth/magic`).
 *
 * Conflicts:
 *   - email already registered → 409 with `code: "email_taken"`
 *   - handle already taken    → 409 with `code: "handle_taken"`
 *
 * Rate limiting lives in src/lib/auth/ratelimit.ts (in-memory for YIL-4,
 * swap to Redis when traffic warrants).
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/auth/password";
import { createSession, SESSION_TTL } from "@/lib/auth/session";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/cookies";
import {
  registerSchema,
  invalidRequest,
  type ValidationFailure,
} from "@/lib/auth/validate";

export const runtime = "nodejs";

function uniqueHandle(email: string, chosen?: string): string {
  const base =
    chosen ?? email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return base.slice(0, 32) || "user";
}

async function deriveUniqueHandle(base: string): Promise<string> {
  const truncated = base.slice(0, 28);
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? truncated : `${truncated}_${i}`;
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  // Last resort: append a random suffix. Will not collide in practice.
  return `${truncated}_${Math.random().toString(36).slice(2, 8)}`;
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
  const parsed = registerSchema.safeParse(json);
  if (!parsed.success) {
    const failure: ValidationFailure = invalidRequest(parsed.error.issues);
    return NextResponse.json(failure.body, { status: failure.status });
  }
  const { email, password, handle, displayName } = parsed.data;

  // Reject if email already exists.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return NextResponse.json(
      { error: { code: "email_taken" } },
      { status: 409 }
    );
  }

  // If the client supplied a handle, validate uniqueness up-front.
  if (handle) {
    const [existingHandle] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    if (existingHandle) {
      return NextResponse.json(
        { error: { code: "handle_taken" } },
        { status: 409 }
      );
    }
  }

  const passwordHash = await hashPassword(password);
  const finalHandle = await deriveUniqueHandle(uniqueHandle(email, handle));

  const [created] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      handle: finalHandle,
      displayName:
        displayName && displayName.length > 0
          ? displayName
          : email.split("@")[0],
      emailVerified: false,
    })
    .returning();

  const { token } = await createSession({
    userId: created.id,
    userAgent: req.headers.get("user-agent"),
    ipHash: null,
  });

  const res = NextResponse.json(
    {
      user: {
        id: created.id,
        email: created.email,
        handle: created.handle,
        displayName: created.displayName,
        emailVerified: created.emailVerified,
      },
    },
    { status: 201 }
  );
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL));
  return res;
}