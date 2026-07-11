/**
 * Stripe SDK singleton + config guards (YIL-9).
 *
 * Centralises:
 *   - API version pinning (no implicit upgrades when Stripe ships a new
 *     API version; we upgrade explicitly with a code change + review).
 *   - Test/live guard (live keys throw — refuses to boot).
 *   - Webhook signature secret loading.
 *   - Lazy construction so that unit tests that never touch Stripe don't
 *     need env vars set.
 *
 * The returned `Stripe` client is shared across all `payments/*` modules.
 * Callers MUST pass an `idempotencyKey` on every write call.
 */

import Stripe from "stripe";

/** Pin a specific API version. Bump explicitly when migrating. */
export const STRIPE_API_VERSION = "2024-06-20" as const;

/** Marker so we can refuse to boot with a live key by accident. */
const LIVE_KEY_PREFIX = "sk_live_";
const TEST_KEY_PREFIX = "sk_test_";

declare global {
  // eslint-disable-next-line no-var
  var __yilStripeClient: Stripe | undefined;
}

function makeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 10_000,
    appInfo: {
      name: "yil-marketplace",
      version: "0.1.0",
    },
  });
}

/**
 * Lazy, cached Stripe client.
 *
 * Throws `StripeConfigError` (with a clear message) if env is missing or
 * misconfigured. The caller is expected to translate that into an HTTP 500
 * with a generic message — never echo the secret back to the client.
 */
export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConfigError";
  }
}

export function getStripeClient(): Stripe {
  if (globalThis.__yilStripeClient) {
    return globalThis.__yilStripeClient;
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new StripeConfigError(
      "STRIPE_SECRET_KEY is not set. Refusing to construct Stripe client."
    );
  }
  if (key.startsWith(LIVE_KEY_PREFIX)) {
    throw new StripeConfigError(
      "STRIPE_SECRET_KEY is a LIVE key. Refusing to construct Stripe client — this build is test-mode only."
    );
  }
  if (!key.startsWith(TEST_KEY_PREFIX)) {
    throw new StripeConfigError(
      "STRIPE_SECRET_KEY must start with 'sk_test_' (test mode). Live keys are forbidden in this build."
    );
  }
  globalThis.__yilStripeClient = makeClient(key);
  return globalThis.__yilStripeClient;
}

/** Webhook signing secret. Throws if missing — the route will 500. */
export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new StripeConfigError(
      "STRIPE_WEBHOOK_SECRET is not set. Refusing to accept webhooks."
    );
  }
  return secret;
}

/**
 * Publishable key for client-side use. Safe to expose to the browser.
 * Returns null when unset — the checkout client can then render the
 * "payments disabled" fallback rather than crashing.
 */
export function getStripePublishableKey(): string | null {
  return process.env.STRIPE_PUBLISHABLE_KEY ?? null;
}

/**
 * For tests: reset the cached client so a new key/secret can be picked up.
 * Not exported from `index.ts`; only consumed by vitest setup helpers.
 */
export function _resetStripeClientForTests(): void {
  globalThis.__yilStripeClient = undefined;
}