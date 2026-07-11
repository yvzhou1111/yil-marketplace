/**
 * Password hashing — YIL-4.
 *
 * Pure wrapper around `bcryptjs` so the rest of the codebase never imports
 * bcrypt directly. Costs and salts are configured here; if we ever want to
 * migrate to argon2id or upgrade the cost factor, this is the one place to
 * change.
 *
 * Why bcryptjs (not `bcrypt`):
 *   - Pure-JS, no native build step. Works on every deploy target
 *     (Vercel, Docker, CI runner) without a compiler toolchain.
 *   - For a marketplace at week-1 traffic the throughput is fine; if we
 *     outgrow it we can swap to `argon2` behind the same interface.
 *
 * Cost factor 12 is the 2024 OWASP recommendation baseline for bcrypt.
 * It is intentionally a single tunable constant here — never inline.
 */
import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("hashPassword: password must be a non-empty string");
  }
  // bcrypt has a 72-byte input cap; pre-truncate to avoid silent truncation
  // producing different hashes for "password" and "password   ...". We
  // surface a hard error in `validate.ts` instead if the user passes
  // something absurdly long.
  return bcrypt.hash(plaintext.slice(0, 72), BCRYPT_COST);
}

export async function verifyPassword(
  plaintext: string,
  hash: string | null | undefined
): Promise<boolean> {
  if (!hash) return false;
  if (typeof plaintext !== "string" || plaintext.length === 0) return false;
  try {
    return await bcrypt.compare(plaintext.slice(0, 72), hash);
  } catch {
    // Malformed hash should not crash the login path; report "no match".
    return false;
  }
}