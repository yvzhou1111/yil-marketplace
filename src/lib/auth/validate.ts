/**
 * Request validation — YIL-4.
 *
 * Single home for the Zod schemas that gate every auth route. The handlers
 * `safeParse` the body and translate the result into a 400 with a
 * machine-readable `error.code` so the client can show useful messages.
 */
import { z } from "zod";

// Email: RFC-5322-ish but lenient. Lowercased before insertion.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

// Password policy:
//  - 10..200 chars
//  - at least one letter and one digit (OWASP 2024 minimum for new accounts)
//  - we do NOT enforce special chars (UX cost outweighs marginal security
//    gain at our length floor)
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200, "Password is too long (max 200)")
  .refine((v) => /[A-Za-z]/.test(v), "Password must contain a letter")
  .refine((v) => /\d/.test(v), "Password must contain a digit");

export const handleSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "Handle must be lowercase letters, digits, or _")
  .optional();

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  handle: handleSchema,
  displayName: z.string().trim().max(80).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const magicRequestSchema = z.object({
  email: emailSchema,
});

export const magicVerifySchema = z.object({
  token: z.string().min(8).max(512),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type MagicRequestInput = z.infer<typeof magicRequestSchema>;
export type MagicVerifyInput = z.infer<typeof magicVerifySchema>;

export type ValidationFailure = {
  ok: false;
  status: 400;
  body: { error: { code: "invalid_request"; issues: unknown } };
};

export function invalidRequest(issues: unknown): ValidationFailure {
  return {
    ok: false,
    status: 400,
    body: { error: { code: "invalid_request", issues } },
  };
}