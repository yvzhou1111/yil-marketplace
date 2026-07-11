/**
 * Crypto primitives — YIL-4.
 *
 * Thin wrappers over Node's `crypto` so the rest of the codebase never
 * imports `crypto` directly. We always use:
 *   - `randomBytes` from `crypto.randomBytes` (CSPRNG).
 *   - SHA-256 only as an *indexing* hash for non-secret tokens
 *     (session cookie values, magic-link tokens) — never as a password
 *     hash and never as a MAC.
 *
 * Why SHA-256 for the index, not HMAC:
 *   These tokens are themselves high-entropy random values from the
 *   CSPRNG. There is no key material to keep secret — an attacker who
 *   sees the SHA-256 cannot reverse it to the original token because
 *   the original token is 256 bits of random. We don't need HMAC here
 *   because we don't need integrity on a known value; we need an
 *   indexed lookup.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes of CSPRNG entropy, returned as a URL-safe base64 string. */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/** SHA-256 hex digest — used as the index for stored tokens. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string compare. Returns false on length mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}