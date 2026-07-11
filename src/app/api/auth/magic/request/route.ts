/**
 * POST /api/auth/magic/request
 *
 * Body: { email }.
 *
 * Always responds 202 — even when the address is unknown. This is so the
 * endpoint cannot be used as an email-enumeration oracle. If the email
 * belongs to a registered user, a magic link is mailed; if not, the
 * request is silently dropped. The verification email after password
 * sign-up reuses this route with `purpose: "verify_email"`.
 *
 * For week-1 we don't differentiate purpose in the request body — the
 * caller picks "signin" if the account might exist and "verify_email"
 * otherwise. See `validate.ts`.
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { issueMagicLink } from "@/lib/auth/magicLink";
import { sendMagicLinkEmail } from "@/lib/auth/email";
import { magicRequestSchema, invalidRequest } from "@/lib/auth/validate";

export const runtime = "nodejs";

function buildMagicUrl(token: string): string {
  const base =
    process.env.PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/auth/verify?token=${encodeURIComponent(token)}`;
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
  const parsed = magicRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(invalidRequest(parsed.error.issues).body, {
      status: 400,
    });
  }
  const { email } = parsed.data;

  // Look up the user. We deliberately do not 404: a 202 always tells the
  // caller "we tried, check your inbox". If the user does exist, we issue
  // the token and send the email.
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);

  if (user) {
    const { rawToken, expiresAt } = await issueMagicLink({
      email,
      purpose: "signin",
    });
    await sendMagicLinkEmail({
      to: email,
      url: buildMagicUrl(rawToken),
      expiresAt,
    });
  }

  return new NextResponse(null, { status: 202 });
}