/**
 * Cookie configuration — YIL-4.
 *
 * Centralized so every auth route reads and writes the same cookie name
 * with the same attributes. The defaults are intentionally strict:
 *   - HttpOnly  : JS in the page cannot read the cookie (XSS-resistant).
 *   - SameSite=Lax : blocks most CSRF without breaking top-level navigation.
 *   - Secure    : only sent over HTTPS. Set to false in development only.
 *   - Path=/    : the cookie is sent to every API route.
 *
 * The cookie carries a signed JWT, not the user id — see `session.ts` for
 * the format and the verification path.
 */

export const SESSION_COOKIE = "yil_session";

export type CookieOptions = {
  httpOnly: boolean;
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
  path: string;
  maxAge?: number;
  expires?: Date;
};

export function defaultCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
  };
}

export function sessionCookieOptions(maxAgeSeconds: number): CookieOptions {
  return { ...defaultCookieOptions(), maxAge: maxAgeSeconds };
}