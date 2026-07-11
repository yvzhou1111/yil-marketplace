/**
 * Session JWT — YIL-4.
 *
 * The cookie carries a signed JWT whose payload is the minimum needed to
 * identify the session without a database round-trip:
 *
 *   {
 *     sid: string,   // auth_sessions.id (uuid)
 *     sub: string,   // users.id         (uuid)
 *     exp: number,   // unix-seconds expiry
 *     iat: number,   // unix-seconds issued-at
 *   }
 *
 * Verification is `jose.jwtVerify` with HS256 over `SESSION_SECRET`. The
 * database is then consulted for `revoked_at IS NULL AND expires_at > now()`
 * — that DB hit is what lets us revoke a session immediately.
 *
 * Why HS256 (not RS256 / EdDSA):
 *   We have a single deploy target; we never need to verify the cookie
 *   from a service that doesn't hold the secret. HS256 keeps the deploy
 *   simple (one env var, no key rotation ceremony) and avoids premature
 *   complexity. If we add a second service that needs to verify sessions
 *   without holding the signing key, we will move to RS256 then.
 */
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { db } from "@/db/client";
import { authSessions, users, type AuthSession, type User } from "@/db/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import { sha256Hex } from "./crypto";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const JWT_ALG = "HS256";

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET must be set to a random string of at least 32 characters. " +
        "Generate one with: openssl rand -base64 48"
    );
  }
  return new TextEncoder().encode(secret);
}

export type SessionClaims = {
  sid: string;
  sub: string;
  exp: number;
  iat: number;
};

export type SessionContext = {
  user: User;
  session: AuthSession;
};

/**
 * Create a new session for a user. Returns the cookie value (signed JWT)
 * and the DB row id so the caller can issue the cookie and audit.
 */
export async function createSession(opts: {
  userId: string;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  // We insert the row with a placeholder token hash, then sign the JWT
  // and update the row with sha256(JWT). The cookie value is the JWT
  // itself; we look it up by sha256(JWT). The intermediate random-token
  // dance is gone — there is no secret to leak besides AUTH_SECRET.
  const placeholder = "pending";
  const [row] = await db
    .insert(authSessions)
    .values({
      userId: opts.userId,
      tokenHash: placeholder,
      userAgent: opts.userAgent ?? null,
      ipHash: opts.ipHash ?? null,
      expiresAt,
    })
    .returning();

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(opts.userId)
    .setJti(row.id)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getSecret());

  const tokenHash = sha256Hex(jwt);
  await db
    .update(authSessions)
    .set({ tokenHash })
    .where(eq(authSessions.id, row.id));

  return { token: jwt, sessionId: row.id, expiresAt };
}

/**
 * Verify a cookie value (signed JWT) and return the active session.
 *
 * Returns null when:
 *   - the JWT is malformed / signature invalid / expired
 *   - the session row is missing
 *   - the session row is revoked
 *   - the user referenced by the session no longer exists or is deleted
 *
 * Always returns null on failure; never throws. The caller decides whether
 * to surface a 401.
 */
export async function verifySessionToken(
  cookieValue: string
): Promise<SessionContext | null> {
  if (!cookieValue) return null;

  let claims: SessionClaims;
  try {
    const verified = await jwtVerify(cookieValue, getSecret(), {
      algorithms: [JWT_ALG],
    });
    claims = {
      sid: String(verified.payload.jti),
      sub: String(verified.payload.sub),
      exp: Number(verified.payload.exp),
      iat: Number(verified.payload.iat),
    };
  } catch (err) {
    // Signature invalid, expired, malformed. Treat as "no session".
    if (
      err instanceof joseErrors.JWTExpired ||
      err instanceof joseErrors.JWTClaimValidationFailed ||
      err instanceof joseErrors.JWSInvalid ||
      err instanceof joseErrors.JWSSignatureVerificationFailed ||
      err instanceof joseErrors.JWTInvalid
    ) {
      return null;
    }
    return null;
  }

  const now = new Date();
  const [row] = await db
    .select({
      session: authSessions,
      user: users,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.id, claims.sid),
        eq(authSessions.tokenHash, sha256Hex(cookieValue)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (!row) return null;

  // Bump last_seen_at opportunistically. Fire-and-forget; a failure here
  // should not break the request.
  void db
    .update(authSessions)
    .set({ lastSeenAt: now })
    .where(eq(authSessions.id, claims.sid))
    .catch(() => {
      /* swallow */
    });

  return { user: row.user, session: row.session };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(eq(authSessions.id, sessionId));
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt))
    );
}

export const SESSION_TTL = SESSION_TTL_SECONDS;