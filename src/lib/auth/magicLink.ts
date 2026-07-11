/**
 * Magic-link tokens — YIL-4.
 *
 * Two flows, both built on the same primitives:
 *   1. Passwordless sign-in / sign-up.
 *   2. Email verification (after a password sign-up we mail a link).
 *
 * Security model:
 *   - The raw token is 32 bytes from a CSPRNG, base64url-encoded → 256 bits
 *     of entropy. We send it in the email and never persist it.
 *   - We persist `sha256(token)` so the DB can index it; a DB leak cannot
 *     be used to forge a token.
 *   - Tokens are single-use (`consumed_at IS NOT NULL`) and short-lived
 *     (default 15 minutes).
 *   - `purpose` ties a token to a flow; a "signin" token cannot be used as
 *     "verify_email" and vice versa.
 */
import { db } from "@/db/client";
import { magicLinkTokens } from "@/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { generateToken, sha256Hex } from "./crypto";

const TOKEN_TTL_SECONDS = 60 * 15; // 15 minutes

export type MagicLinkPurpose = "signin" | "verify_email";

export type IssuedMagicLink = {
  /** The raw token to embed in the email link. Never stored. */
  rawToken: string;
  expiresAt: Date;
};

/**
 * Issue a new magic link token. Returns the raw token + expiry; the caller
 * is responsible for sending it by email. Any previous unconsumed tokens
 * for the same (email, purpose) are left in place — the most recent wins,
 * and expired tokens are GC'd by a separate cron (out of scope for YIL-4).
 */
export async function issueMagicLink(opts: {
  email: string;
  purpose: MagicLinkPurpose;
  ttlSeconds?: number;
}): Promise<IssuedMagicLink> {
  const rawToken = generateToken(32);
  const ttl = opts.ttlSeconds ?? TOKEN_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await db.insert(magicLinkTokens).values({
    email: opts.email.toLowerCase(),
    tokenHash: sha256Hex(rawToken),
    purpose: opts.purpose,
    expiresAt,
  });

  return { rawToken, expiresAt };
}

export type ConsumedMagicLink = {
  email: string;
  purpose: MagicLinkPurpose;
};

/**
 * Consume a magic link token. Single-use, atomic. Returns null if the
 * token is unknown, expired, already consumed, or for a different purpose.
 */
export async function consumeMagicLink(opts: {
  rawToken: string;
  purpose: MagicLinkPurpose;
}): Promise<ConsumedMagicLink | null> {
  if (!opts.rawToken) return null;
  const tokenHash = sha256Hex(opts.rawToken);

  const now = new Date();
  const [row] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(magicLinkTokens.tokenHash, tokenHash),
        eq(magicLinkTokens.purpose, opts.purpose),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, now)
      )
    )
    .returning({
      email: magicLinkTokens.email,
      purpose: magicLinkTokens.purpose,
    });

  if (!row) return null;

  return {
    email: row.email,
    purpose: row.purpose as MagicLinkPurpose,
  };
}

export const MAGIC_LINK_TTL = TOKEN_TTL_SECONDS;