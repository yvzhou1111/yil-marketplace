/**
 * Next.js instrumentation entry point.
 *
 * Next.js calls this file once per server process before any route handler
 * runs. We use it to initialize Sentry on the server side.
 *
 * Reference: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initSentryServer } = await import("./src/lib/observability/sentry");
    await initSentryServer();
  }
}