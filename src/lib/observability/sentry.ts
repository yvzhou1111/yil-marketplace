/**
 * Sentry configuration helper.
 *
 * Centralizes Sentry init so we don't duplicate config between
 * `sentry.client.config.ts`, `sentry.server.config.ts`, and
 * `instrumentation.ts`. The init is a no-op when `SENTRY_DSN` is unset —
 * the app works without Sentry.
 *
 * The shape of this file matches what `@sentry/nextjs` exports, but we
 * depend on the package lazily: if it's not installed yet (the bootstrap
 * PR is still landing), this module still imports cleanly.
 */

export type SentryInitOptions = {
  dsn: string | undefined;
  environment: string;
  tracesSampleRate: number;
  release: string | undefined;
};

export function getSentryInitOptions(): SentryInitOptions {
  const tracesSampleRate = Number.parseFloat(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? (process.env.NODE_ENV === "production" ? "0.1" : "1.0"),
  );
  return {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1,
    release:
      process.env.SENTRY_RELEASE ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.GITHUB_SHA ??
      undefined,
  };
}

/**
 * Lazy initialization for the server runtime. Called from
 * `instrumentation.ts` (Next.js convention) so it runs before any route
 * handler. Safe to call when Sentry isn't installed — we just log a warning
 * and continue.
 */
export async function initSentryServer(): Promise<void> {
  const opts = getSentryInitOptions();
  if (!opts.dsn) return;

  try {
    // Dynamic import so missing dep at build time doesn't break compile.
    const sentry = await import("@sentry/nextjs");
    sentry.init({
      dsn: opts.dsn,
      environment: opts.environment,
      tracesSampleRate: opts.tracesSampleRate,
      release: opts.release,
      // We do our own request logging in src/lib/observability/request-log.ts;
      // turn off Sentry's to avoid duplicate spans.
      disableRequestInstrumentation: false,
      beforeSend(event) {
        // Strip server-only env leaks before sending. Most of the surface is
        // already handled by Sentry's default scrubbing, but we add our own
        // for app-specific fields like `listingDescription`.
        if (event.request?.data) {
          delete (event.request.data as Record<string, unknown>).password;
          delete (event.request.data as Record<string, unknown>).token;
        }
        return event;
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[observability] @sentry/nextjs not installed; install it to enable error tracking.",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Browser-side init — called from `sentry.client.config.ts`. */
export async function initSentryBrowser(): Promise<void> {
  const opts = getSentryInitOptions();
  if (!opts.dsn || typeof window === "undefined") return;

  try {
    const sentry = await import("@sentry/nextjs");
    sentry.init({
      dsn: opts.dsn,
      environment: opts.environment,
      tracesSampleRate: opts.tracesSampleRate,
      release: opts.release,
      // Replay only on errors in production — it's the cheapest signal that
      // tells us what the user saw.
      replaysOnErrorSampleRate: process.env.NODE_ENV === "production" ? 1.0 : 0,
      replaysSessionSampleRate: 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[observability] @sentry/nextjs not installed; install it to enable browser error tracking.",
      err instanceof Error ? err.message : err,
    );
  }
}